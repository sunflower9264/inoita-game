

import { UiNode, UiImage } from './dom/node.ts';

import { memberSkillGrowth } from '../domain/battle.ts';

import { AttributeAllocation } from '../domain/attribute-allocation.ts';
import { effectiveCharacterPanel, PRIMARY_STATS, type PrimaryStat } from '../domain/character-stats.ts';
import type { BattleStatKey } from '../domain/battle-semantics.ts';
import { memberCombatModifiers } from '../domain/party-combat.ts';
import { memberArt as memberArtwork } from '../domain/menu-panels.ts';
import { characterCombatValues } from './character-values.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';

import type { CompanionMember } from '../domain/party.ts';

import { NumberPrompt } from './number-prompt.ts';

import { GOLD, UiSurface } from './widgets.ts';
import { MenuTextLayer, type MenuTextSpec, type MenuTextWriter } from './dom/menu-text.ts';

import { drawRoundBand } from './panels/round-band.ts';
import { drawSolidBorder } from './panels/solid-border.ts';
import { MENU_FRAME_MODAL_HEIGHT, MENU_FRAME_MODAL_WIDTH } from './panels/modal-placement.ts';

import { TEXT_COLORS } from './text-style.ts';

import type { WorldIndex, ActorDefinition } from '../domain/content.ts';

const AREA_TEXT=TEXT_COLORS.primary;

export type StatusMember=NonNullable<Session['hero']>|CompanionMember;
export interface StatusPageHost {
 readonly app:Pick<StoryUIContext,'menuPanels'|'storyClasses'|'battleCatalog'|'combatStealthed'|'combatAttribute'>;
 readonly session:Session; readonly world:WorldIndex; readonly selectedMemberId:string; readonly page:string;
 readonly body:UiSurface|undefined; readonly modal:UiSurface|undefined; readonly surface:UiSurface|undefined; readonly menuText:MenuTextLayer|undefined;
 notice:string; keyboardFocus:UiNode|undefined;

 drawPartyColumn(view:UiSurface):void; modalTextSpec(spec:MenuTextSpec):MenuTextSpec; beginModal(width:number,height:number):void;
 sync():void; render():void; isBusy():boolean; acknowledge():void;
}
export class StatusPage {
 private readonly host:StatusPageHost;
 private busy=false;
 private statusTextSpecs:MenuTextSpec[]=[]; private statusModalTextSpecs:MenuTextSpec[]=[];
 private statusPortrait?:UiImage;private statusAdjustButton?:UiNode;private statusRightNodes:UiNode[]=[];
 private allocationButtons=new Map<PrimaryStat,{minus:UiNode;plus:UiNode}>();private statusRightAdjusting=false;
 private statusResources=new Map<string,{fill:UiImage;start:UiImage;end:UiImage}>();
 private allocation?:AttributeAllocation;private allocationExit?:()=>void;private allocationError='';private adjusting=false;
 private readonly allocationPrompt=new NumberPrompt();
 constructor(host:StatusPageHost){this.host=host;}
 private member():StatusMember|undefined{return this.host.selectedMemberId==='player'?this.host.session.hero:this.host.session.party?.get(this.host.selectedMemberId);}
 private actor():ActorDefinition{const member=this.member()!;return this.host.world.actors[this.host.selectedMemberId==='player'?this.host.session.campaign.start.actor:(member as CompanionMember).definition.actor];}
 private memberArt(){const member=this.member()!;return memberArtwork(this.host.app.menuPanels,this.actor(),member.classId,this.host.selectedMemberId==='player'?undefined:(member as CompanionMember).source);}
 private configuration(){return this.host.selectedMemberId==='player'?this.host.session.skills:(this.member() as CompanionMember).skills;}
 get confirming():boolean{return !!this.allocationExit;}
 get prompting():boolean{return this.allocationPrompt.active;}
 get mounted():boolean{return !!this.statusPortrait?.active;}
 get isBusy():boolean{return this.busy;}
 closePrompt():void{this.allocationPrompt.close();}
 cancelPress():void{for(const pair of this.allocationButtons.values())for(const node of [pair.minus,pair.plus])node.getData('cancelPress')?.();}
 destroy():void{this.discardAllocation();this.statusRightNodes=[];this.statusResources.clear();this.allocationButtons.clear();this.statusPortrait=undefined;this.statusAdjustButton=undefined;this.statusTextSpecs=[];this.statusModalTextSpecs=[];}
renderStatusText(writer:MenuTextWriter):void{
    for(const spec of this.statusTextSpecs)writer.add(spec);
  }
renderStatusModalText(writer:MenuTextWriter):void{
    for(const spec of this.statusModalTextSpecs)writer.add(this.host.modalTextSpec(spec));
  }
private addStatusText(key:string,text:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={}):void{
    this.statusTextSpecs.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style}});
  }
renderStatus():void{
    this.statusTextSpecs=[];this.statusResources.clear();
    const v=this.host.body!,member=this.member()!,actor=this.actor(),panels=this.host.app.menuPanels,character=this.host.app.storyClasses.classes.find(value=>value.id===member.classId)!,art=this.memberArt();
    // 左框只有图框（`UI_DrawBorderRect`），四角 41×41 画在框外 2 像素处：`Scene_Draw_POPUP_SC_CHARACTER_INFO
    // @0x1e6b78` 把组 15 索引 48／49／53／54 画在 (83,−2)、(455,−2)、(83,392)、(455,392)，立绘在 (95,10)。
    v.border(panels.assets,85,0,409,431);
    for(const [corner,x,y]of [['nw',83,-2],['ne',455,-2],['sw',83,392],['se',455,392]] as const)v.image(panels.assets[`character-${corner}`],x,y,41,41);
    this.statusPortrait=v.imageCover(art.image,95,10,252,271);
    // 队员栏：原版这个 104×340 的栏里放三个 104×113 的成员按钮（`Scene_Init_POPUP_SC_CHARACTER_INFO
    // @0x1e5478` 里 `SetRect(?, 0/0x71/0xe2, 104, 113)`），每个画成员头像 86×96 落在框内 +(9,9)，
    // 所以第一格的头像就在 (17,58)；点哪一格就切到那位成员身上。
    this.host.drawPartyColumn(v);
    // 等级、职业、姓名三行都在 x=458 右对齐（`+0x1ca`），全部按上沿对齐：
    // 等级 `+0x5f`(95)、职业 `+0x78`(120)、姓名再让出字距落在 152。
    // 姓名不再以 150 为中线，否则更大的字号会压到职业行上。三行都是原版的米色 #e2cb9e。
    this.addStatusText('level',`等级 ${member.level}`,458,95,20,AREA_TEXT,1,0,{width:200,align:'right'});
    this.addStatusText('class',character.name,458,120,20,AREA_TEXT,1,0,{width:200,align:'right'});
    this.addStatusText('name',actor.name,458,152,26,AREA_TEXT,1,0,{width:200,align:'right'});
    (['health','mana','experience'] as const).forEach((kind,index)=>{const player=member.player,value=player[kind],max=kind==='experience'?player.nextLevelExperience:kind==='health'?player.maxHealth:player.maxMana,y=290+index*44,ratio=kind==='experience'&&max===0?1:max>0?Math.max(0,Math.min(1,value/max)):0;
      v.image(panels.assets['character-gauge'],168,y,243,37);
      this.addStatusText(`resource-${kind}-label`,panels.character.labels[kind],118,y+18.5,19,GOLD,0,.5,{width:46,align:'right'});
      this.addStatusText(`resource-${kind}-value`,max===0?'已满级':`${value} / ${max}`,290,y+18.5,17,GOLD,.5,.5,{contrastBackground:true});
      this.addStatusText(`resource-${kind}-percent`,`${Math.floor(ratio*100)}%`,455,y+18.5,17,GOLD,1,.5);
      const width=223*ratio,fill=v.image(panels.assets[`character-${kind}-fill`],178,y+12,223,13);fill.setCrop(0,0,fill.width*ratio,fill.height).setVisible(width>0);const start=v.image(panels.assets[`character-${kind}-start`],178,y+12,7,13).setVisible(width>0),end=v.image(panels.assets[`character-${kind}-end`],178+Math.max(0,width-7),y+12,7,13).setVisible(width>0);this.statusResources.set(kind,{fill,start,end});
    });
    this.renderStatusRight();
  }
private renderStatusRight():void{
    const v=this.host.body!,member=this.member()!,panels=this.host.app.menuPanels,character=this.host.app.storyClasses.classes.find(value=>value.id===member.classId)!;
    const hero='source' in member&&member.source!=='mercenary'?undefined:member,statPoints=this.allocation?.remainingPoints??hero?.statPoints??0,attributes=this.allocation?.attributes??member.panel.attributes;
    const before=new Set(v.root.list);this.allocationButtons.clear();
    // 右侧两块同样只有图框：原版 `Scene_Draw_...` 只对它们调 `UI_DrawBorderRect`，
    // 加点时属性栏宽 409（画到 x=905），常态宽 224，战斗指标栏固定在 `+0xe2`(226) 处、224 宽。
    // 两种视图都由 53 高的标题和 y=49 起的内容框相接，宽度分别为 224、409。
    const attributeWidth=this.adjusting?409:224;
    drawSolidBorder(v,panels.assets,496,0,attributeWidth,53);
    v.border(panels.assets,496,49,attributeWidth,382);
    // 加点视图那五行按原版排：行距 64（`Scene_Draw_... 0x1e761c` 的 `x21 += 0x40`），
    // 每行一条 (519, 行顶+75, 364, 48) 的压暗圆角带（强度 50），名字从 (531, 行顶+85) 起、
    // 数值右对齐于 751、行顶 +84；加减按钮是两个 51×58 的列，减在 630、加在 822（`Scene_Init`
    // 里两组 `UI_CreateGroupBaseControl(134/326, 70, 51, 314)`，按钮按 64 行距排）。
    // 加点视图每行右侧那串橙色「+N」是这项能力累计投入的点数：已确认的分配加上本轮
    // 还没确认的增量。没有投入时不画。
    const allocated=hero?.allocated;
    character.attributes.forEach((attribute,index)=>{
      const stat=PRIMARY_STATS[index],adjusting=this.adjusting;
      // 两档的行距与落点不同：加点视图 64 行距、名字 531、数值右对齐 751、圆角带 364 宽；
      // 总览视图 69 行距、名字 525、数值右对齐 684、圆角带 (513, 行顶+75, 190, 48)。
      if(adjusting)drawRoundBand(v,panels.assets,519,index*64+75,364,48,50);
      else drawRoundBand(v,panels.assets,513,index*69+75,190,48,50);
      const nameX=adjusting?531:525,nameY=adjusting?index*64+85:index*69+85;
      this.addStatusText(`attribute-${stat}-name`,attribute.name,nameX,nameY,23);
      this.addStatusText(`attribute-${stat}-value`,String(attributes[stat]),adjusting?751:684,adjusting?index*64+84:index*69+84,23,GOLD,1,0);
      const added=(allocated?.[stat]??0)+(this.allocation?.pending[stat]??0);
      if(adjusting)this.addStatusText(`attribute-${stat}-added`,added>=1?`+${added}`:'',781,index*64+84,23,'#e1823b');
      if(adjusting&&this.allocation){
        // 原版减点使用左箭头，增点翻转同图；按下叠加对应亮图，透明处露出属性行底带。
        for(const [delta,x,label,disabled] of [[-1,630,'减少',this.allocation.pending[stat]===0],[1,822,'增加',statPoints<1]] as const){
          const button=v.button('',x,index*64+70,51,58,()=>this.changeAllocation(stat,delta),{
            image:panels.assets['character-step'],pressed:panels.assets['character-step-pressed'],native:true,disabled,hold:{delayMs:400,intervalMs:90},
          }).setData('label',`${label}${attribute.name}`);
          const pair=this.allocationButtons.get(stat)??{} as {minus:UiNode;plus:UiNode};
          if(delta===-1)pair.minus=button;else pair.plus=button;this.allocationButtons.set(stat,pair);
          if(delta===1)for(const part of ['face','highlight']) (button.getData(part) as UiImage).setFlipX(true);
        }
        // 数值和「+N」所在的那一段点一下就能直接输入本轮点数。
        v.button('',690,index*64+70,125,58,()=>this.beginAllocationInput(stat),{bare:true})
          .setData('label',`输入${attribute.name}加点`);
      }
    });
    this.statusAdjustButton=v.button('',this.adjusting?846:661,0,67,67,()=>this.toggleAllocation(),{image:panels.assets[this.adjusting?'confirm':'character-adjust'],disabled:!hero}).setData('label',this.adjusting?'确认属性加点':'查看属性加点');
    if(!this.adjusting){
      const values=this.statusCombatValues(member);
      v.border(panels.assets,722,0,224,431);
      panels.character.combatLabels.forEach((label,index)=>{
        this.addStatusText(`combat-${index}-label`,label,738,24+index*35,19,GOLD,0,0,{width:110,align:'left'});
        this.addStatusText(`combat-${index}-value`,values[index],928,24+index*35,19,GOLD,1,0);
      });
    }else{
      v.button('',571,376,257,48,()=>this.resetAllocation()).setData('label','能力初始化');
      this.addStatusText('reset-attributes','能力初始化',571+257/2,376+48/2,Math.min(22,48*.42),GOLD,.5,.5);
    }
    this.addStatusText('stat-points',`${panels.character.labels.statPoints} ${statPoints}`,this.adjusting?534:522,14,20,AREA_TEXT);
    this.statusRightNodes=v.root.list.filter(node=>!before.has(node));this.statusRightAdjusting=this.adjusting;
  }
private toggleAllocation():void{
    if(this.adjusting){if(this.requestAllocationExit(()=>{this.host.modal?.clear();this.updateStatusMember();}))return;}
    else{const hero=this.member();if(!hero||('source' in hero&&hero.source!=='mercenary'))return;this.allocation=new AttributeAllocation(hero);this.adjusting=true;}
    this.updateStatusMember();
  }
private changeAllocation(stat:PrimaryStat,delta:1|-1):void{
    if(this.busy||!this.allocation)return;
    try{this.allocation.change(stat,delta);this.updateStatusMember();}
    catch(error){this.host.notice=(error as Error).message;this.host.menuText?.renderPage('status');}
  }
private beginAllocationInput(stat:PrimaryStat):void{
    // 另一根手指可能还按着「+/-」；打开输入卡前先停掉后台连加，避免读到的上限马上过期。
    this.cancelPress();
    const allocation=this.allocation,member=this.member();
    if(this.busy||!allocation||!member)return;
    const character=this.host.app.storyClasses.classes.find(value=>value.id===member.classId);
    const name=character?.attributes[PRIMARY_STATS.indexOf(stat)]?.name??stat;
    const maximum=allocation.pending[stat]+allocation.remainingPoints;
    this.allocationPrompt.show({
      scale:()=>this.host.surface?.root.getWorldTransformMatrix().scaleX??1,
      title:`${name} · 本次加点`,
      hint:maximum<1?'没有可分配的能力点':`本次最多可加 ${maximum} 点`,
      initial:allocation.pending[stat],
      minimum:0,
      maximum,
      overMessage:limit=>limit<1?'没有可分配的能力点':`超过剩余能力点（最多 ${limit} 点）`,
      onConfirm:value=>{
        if(this.allocation!==allocation)return;
        try{allocation.set(stat,value);this.updateStatusMember();}
        catch(error){this.host.notice=(error as Error).message;this.host.menuText?.renderPage('status');}
      },
      onCancel:()=>{},
    });
  }
private resetAllocation():void{
    if((this.busy||this.host.isBusy()))return;this.busy=true;
    try{this.resetAttributes();}catch(error){this.host.notice=(error as Error).message;}
    finally{this.busy=false;}
    this.host.acknowledge();this.updateStatusMember();
  }
private resetAttributes():void{
    const hero=this.member();
    if(!hero||('source' in hero&&hero.source!=='mercenary'))return;
    hero.resetAttributes();
    this.allocation=new AttributeAllocation(hero);
    this.allocationError='';
  }
discardAllocation():void{
    this.cancelPress();this.allocationPrompt.close();
    this.allocation?.cancel();this.allocation=undefined;this.allocationExit=undefined;this.allocationError='';this.adjusting=false;
  }
requestAllocationExit(next:()=>void):boolean{
    if(this.allocationExit)return true;
    if(!this.allocation?.hasChanges){this.discardAllocation();return false;}
    this.allocationExit=next;this.host.keyboardFocus=undefined;
    if(this.host.page==='status'&&this.host.modal){this.host.modal.clear();this.renderAllocationConfirmation();this.host.menuText?.renderPage('status');this.host.sync();}
    else this.host.render();
    return true;
  }
finishAllocation(commit:boolean):void{
    const next=this.allocationExit;if(!next||(this.busy||this.host.isBusy()))return;
    this.busy=true;
    try{if(commit)this.allocation!.commit();this.discardAllocation();}
    catch(error){this.allocationError=(error as Error).message;}
    finally{this.busy=false;}
    if(this.allocationExit){
      if(this.host.page==='status'&&this.host.modal){
        const error=this.statusModalTextSpecs.find(spec=>spec.key==='alloc-error');
        if(error)error.text=this.allocationError;
        else this.statusModalTextSpecs.push({key:'alloc-error',text:this.allocationError,x:35,y:292,style:{size:20,color:GOLD,width:648,wrap:'word'}});
        this.host.menuText?.renderPage('status');this.host.sync();
      }else this.host.render();
      return;
    }
    this.host.keyboardFocus=undefined;next();
  }
renderAllocationConfirmation():void{
    const v=this.host.modal!,character=this.host.app.storyClasses.classes.find(value=>value.id===this.member()!.classId)!,pending=this.allocation!.pending;
    this.statusModalTextSpecs=[];
    const add=(key:string,text:string,x:number,y:number,size:number,width:number):void=>{
      this.statusModalTextSpecs.push({key,text,x,y,style:{size,color:GOLD,width,wrap:'word'}});
    };
    const button=(key:string,text:string,x:number,y:number,width:number,height:number):void=>{
      this.statusModalTextSpecs.push({key,text,x:x+width/2,y:y+height/2,
        style:{size:Math.min(22,height*.42),color:GOLD,anchorX:.5,anchorY:.5}});
    };
    this.host.beginModal(MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT);v.frame(this.host.app.menuPanels.assets,0,0,MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT,1);
    add('alloc-title','确定按当前分配增加能力？',35,30,26,648);
    character.attributes.forEach((attribute,index)=>add(`alloc-${PRIMARY_STATS[index]}`,`${attribute.name}　＋${pending[PRIMARY_STATS[index]]}`,65,91+index*38,22,580));
    if(this.allocationError)add('alloc-error',this.allocationError,35,292,20,648);
    v.button('',270,350,170,48,()=>this.finishAllocation(false)).setData('label','取消');
    v.button('',480,350,190,48,()=>this.finishAllocation(true)).setData('label','确定');
    button('alloc-cancel','取消',270,350,170,48);button('alloc-confirm','确定',480,350,190,48);
  }
updateStatusMember():void{
    const member=this.member()!,actor=this.actor(),panels=this.host.app.menuPanels,character=this.host.app.storyClasses.classes.find(value=>value.id===member.classId)!;
    if(this.statusRightAdjusting!==this.adjusting){
      for(const node of this.statusRightNodes)node.destroy();this.host.body!.pruneDestroyed();
      this.statusTextSpecs=this.statusTextSpecs.filter(spec=>!spec.key.startsWith('attribute-')&&!spec.key.startsWith('combat-')&&spec.key!=='stat-points'&&spec.key!=='reset-attributes');
      this.renderStatusRight();
    }
    const text=(key:string,value:string)=>{const spec=this.statusTextSpecs.find(spec=>spec.key===key);if(spec)spec.text=value;};
    const art=this.memberArt().image;if(this.statusPortrait?.getData('file')!==art)this.statusPortrait?.load(art);
    text('level',`等级 ${member.level}`);text('class',character.name);text('name',actor.name);
    for(const kind of ['health','mana','experience'] as const){
      const player=member.player,value=player[kind],max=kind==='experience'?player.nextLevelExperience:kind==='health'?player.maxHealth:player.maxMana;
      const ratio=kind==='experience'&&max===0?1:max>0?Math.max(0,Math.min(1,value/max)):0,width=223*ratio,view=this.statusResources.get(kind);
      text(`resource-${kind}-value`,max===0?'已满级':`${value} / ${max}`);text(`resource-${kind}-percent`,`${Math.floor(ratio*100)}%`);
      if(view){view.fill.setCrop(0,0,view.fill.width*ratio,view.fill.height).setVisible(width>0);view.start.setVisible(width>0);view.end.setX(178+Math.max(0,width-7)).setVisible(width>0);}
    }
    const heroForAllocation='source' in member&&member.source!=='mercenary'?undefined:member;
    character.attributes.forEach((attribute,index)=>{const stat=PRIMARY_STATS[index];text(`attribute-${stat}-name`,attribute.name);text(`attribute-${stat}-value`,String(this.allocation?.attributes[stat]??member.panel.attributes[stat]));
      const added=(heroForAllocation?.allocated[stat]??0)+(this.allocation?.pending[stat]??0);
      text(`attribute-${stat}-added`,added?`+${added}`:'');
      const buttons=this.allocationButtons.get(stat);buttons?.minus.getData('setEnabled')?.((this.allocation?.pending[stat]??0)>0);buttons?.plus.getData('setEnabled')?.((this.allocation?.remainingPoints??0)>0);});
    const hero='source' in member&&member.source!=='mercenary'?undefined:member;
    text('stat-points',`${panels.character.labels.statPoints} ${this.allocation?.remainingPoints??hero?.statPoints??0}`);
    this.statusAdjustButton?.getData('setEnabled')?.(!!hero);
    this.statusCombatValues(member).forEach((value,index)=>text(`combat-${index}-value`,value));
    this.host.menuText?.renderPage('status');this.host.sync();
  }
private statusCombatValues(member:StatusMember):string[]{
    const equipped=member.bag.equipmentItems(member.bag.equipmentFor(this.host.selectedMemberId)),items=this.host.session!.bag.catalog.items,main=equipped['main-hand'];
    const modifiers=memberCombatModifiers({catalog:this.host.app.battleCatalog,classId:member.classId,loadout:this.configuration().draft(this.host.app.battleCatalog,member.classId),
      weaponKind:main?items[main]?.kind??'unarmed':'unarmed',armorKind:equipped.body?items[equipped.body].kind:'',health:member.player.health,maxHealth:member.player.maxHealth,
      groupEffects:this.host.session!.party?.groupModifiers()??{},growth:memberSkillGrowth(this.host.selectedMemberId),stealthed:this.host.app.combatStealthed?.(this.host.selectedMemberId)??false});
    const combatAttribute=this.host.app.combatAttribute,resolve=combatAttribute?(key:string,base:number)=>combatAttribute(this.host.selectedMemberId,key as BattleStatKey,base,modifiers):undefined;
    return characterCombatValues(effectiveCharacterPanel(member.panel,member.level,modifiers,resolve));
  }
}
