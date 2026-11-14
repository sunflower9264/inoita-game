import {skillForGrowth,memberSkillGrowth} from '../../domain/battle.ts';
import type { StoryUIContext } from '../../application/ports.ts';
import type { Session } from '../../domain/session.ts';
import type { WorldIndex } from '../../domain/content.ts';
import type { CompanionMember, CompanionGroupEffect } from '../../domain/party.ts';
import { memberArt } from '../../domain/menu-panels.ts';
import type { EquipmentSlot } from '../../domain/items.ts';
import { PRIMARY_STATS } from '../../domain/character-stats.ts';
import { skillDetailEntries } from '../../domain/skill-display.ts';
import { LiveCharacterPreview } from './live-character-preview.ts';
import { MENU_FRAME_MODAL_HEIGHT, MENU_FRAME_MODAL_WIDTH, type PlaceModal } from './modal-placement.ts';
import { ACTIVE_PARTY_SLOT_COUNT } from '../../domain/party-slots.ts';
import { drawRoundBand } from './round-band.ts';
import { GOLD, UiSurface, type ScrollArea } from './widgets.ts';
import { slotFrameImage, updateEquipmentLock } from '../slot-frame.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { wrapText } from '../text-layout.ts';
import type { MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiImage, UiNode } from '../dom/node.ts';

type DetailTab = 'info'|'equipment'|'skills';
type PartyModal = {kind:'dismiss';id:string;error?:string}|{kind:'skill';id:string;skill:string}|{kind:'group-skill';id:string;skill:CompanionGroupEffect};
/** 面板借宿主的滚动区登记文字位置；未注入时退回本画布自己的滚动区。 */
type ScrollFactory = (view:UiSurface,name:string,x:number,y:number,width:number,height:number)=>ScrollArea;

/** 名册每页排 3×3 九格；两页共 18 个佣兵槽。 */
const ROSTER_COLUMNS = 3;
const ROSTER_ROWS = 3;
const ROSTER_SLOTS_PER_PAGE = ROSTER_COLUMNS * ROSTER_ROWS;
/** 每名佣兵最多两个佣兵团技能，技能页固定留两行。 */
const GROUP_SKILL_SLOTS = 2;

/** Original two-page mercenary roster, with character details kept beside the roster. */
export class PartyPanel {
  private readonly session:Session;
  private readonly world:WorldIndex;
  private readonly app:StoryUIContext;
  private readonly modalChanged:()=>void;
  private readonly changed:()=>void;
  private readonly inspect:(id:string,page:'bag'|'skills')=>void;
  private readonly scrollArea:ScrollFactory;
  private readonly refreshText:()=>void;
  /** 这一页要显示的文字；图框和按钮仍由 Phaser 画。 */
  private pageText:MenuTextSpec[]=[];
  /** 弹层打开时只保留弹层文字，页面文字不叠在框上。 */
  private modalText:MenuTextSpec[]=[];
  private page=0;
  private selected?:string;
  private tab:DetailTab='info';
  private modal?:PartyModal;
  /** 弹层尺寸交给菜单保存，重绘和缩放共用该尺寸。 */
  private placeModal?:PlaceModal;
  private error='';
  private skillsScroll?:ScrollArea;
  private skillsOffset=0;
  private preparation?:AbortController;
  private readonly preview?:LiveCharacterPreview;
  private previewSlot?:{surface:UiSurface;parent:UiNode;id:string};
  private readonly updateSelection:()=>void;
  private readonly removeScroll:(scroll:ScrollArea)=>void;
  private surface?:UiSurface;
  private selectionMarks=new Map<string,UiNode>();
  private deployedMarkers=new Map<string,UiNode>();
  private rosterCells=new Map<number,{id?:string;button:UiNode;portrait:UiImage}>();
  private pageButton?:UiNode;
  private readonly runAction?:(action:()=>void)=>void;
  private detailNodes:UiNode[]=[];
  private tabs=new Map<DetailTab,UiNode>();
  private bands:{plain:UiNode[];equipment:UiNode[]}={plain:[],equipment:[]};
  private rosterTextCount=0;

  constructor(session:Session,world:WorldIndex,app:StoryUIContext,changed:()=>void,
    inspect:(id:string,page:'bag'|'skills')=>void,scrollArea?:ScrollFactory,refreshText:()=>void=()=>{},preview?:LiveCharacterPreview,
    updateSelection:()=>void=()=>{},removeScroll:(scroll:ScrollArea)=>void=()=>{},modalChanged:()=>void=changed,runAction?:(action:()=>void)=>void){
    this.session=session;this.world=world;this.app=app;this.changed=changed;this.inspect=inspect;
    this.scrollArea=scrollArea??((view,_name,x,y,width,height)=>view.scroll(x,y,width,height));
    this.refreshText=refreshText;
    this.preview=preview;
    this.updateSelection=updateSelection;this.removeScroll=removeScroll;this.modalChanged=modalChanged;this.runAction=runAction;
  }
  get modalOpen():boolean{return !!this.modal;}
  /** 重绘前把合成立绘摘下来，避免被页面清理销毁后无法复用。 */
  detachPreview():void{this.preview?.detach();}
  destroyPreview():void{this.preview?.destroy();}
  close():void{this.modal=undefined;this.preparation?.abort();}
  cancel():void{this.modal=undefined;this.modalChanged();}
  captureScroll():void{this.skillsOffset=this.skillsScroll?.scrollTop??this.skillsOffset;}
  select(id:string):void{
    if(this.selected===id)return;
    const slot=this.session.party!.snapshot().rosterSlots.indexOf(id);
    const previousPage=this.page,previous=this.selected;
    if(slot>=0)this.page=Math.floor(slot/ROSTER_SLOTS_PER_PAGE);
    this.selected=id;this.error='';this.skillsOffset=0;this.modal=undefined;
    if(this.surface&&previousPage===this.page&&this.selectionMarks.has(id)){
      if(previous)this.selectionMarks.get(previous)?.setVisible(false);
      this.selectionMarks.get(id)?.setVisible(true);
      for(const node of this.detailNodes)node.destroy();this.detailNodes=[];
      if(this.skillsScroll){this.removeScroll(this.skillsScroll);this.skillsScroll=undefined;}
      this.preview?.detach();this.previewSlot=undefined;this.surface.pruneDestroyed();
      this.pageText.length=this.rosterTextCount;this.renderSelected(this.surface);this.updateSelection();
    }else{this.skillsScroll=undefined;this.changed();}
    this.prepare(id);
  }
  /** 选中项的外观资源就绪后重绘；切换选择时旧请求作废。 */
  private prepare(id:string):void{
    this.preparation?.abort();const request=this.preparation=new AbortController();
    void this.app.preparePartyMember?.(id,request.signal).then(()=>{if(!request.signal.aborted&&this.selected===id&&this.tab==='equipment')this.updatePreview();})
      .catch(error=>{
        if(request.signal.aborted||this.selected!==id)return;
        this.error=(error as Error).message;
        this.pageText=this.pageText.filter(spec=>spec.key!=='error');
        this.text('error',this.error,70,434,18,TEXT_COLORS.dangerSoft,0,0,{width:808,wrap:'word'});
        this.updateSelection();
      });
  }
  private member(id:string){return id==='player'?this.session.hero:this.session.party!.get(id);}
  private name(id:string):string{return id==='player'?this.world.actors[this.session.campaign.start.actor].name:this.session.party!.get(id)!.definition.name;}
  private portrait(id:string):string{
    const member=this.member(id)!;
    const source=id==='player'?undefined:(member as CompanionMember).source;
    const actor=this.world.actors[id==='player'?this.session.campaign.start.actor:(member as CompanionMember).definition.actor];
    return memberArt(this.app.menuPanels,actor,member.classId,source).partyIcon;
  }
  private run(action:()=>void):void{
    this.error='';
    if(!this.runAction){try{action();}catch(error){this.error=(error as Error).message;this.changed();}return;}
    try{this.runAction(action);}catch(error){this.error=(error as Error).message;}
    this.updatePartyState();
  }
  /** 页面文字交给菜单 DOM 层；弹层打开时页面文字仍输出，由宿主统一压暗和裁剪。 */
  renderText(writer:MenuTextWriter):void{
    for(const spec of this.pageText)writer.add(spec);
  }
  /** 弹层文字仍是弹层本地坐标，由宿主的包装器换算。 */
  renderModalText(writer:MenuTextWriter):void{
    for(const spec of this.modalText)writer.add(spec);
  }
  private text(key:string,value:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={}):void{
    this.pageText.push({key,text:value,x,y,style:{size,color,anchorX,anchorY,...style}});
  }
  private scrolledText(key:string,value:string,x:number,y:number,size:number,color:string,
    scroll:string,clip:{top:number;bottom:number},style:Partial<MenuTextSpec['style']>={}):void{
    this.pageText.push({key,text:value,x,y,scroll,clip,style:{size,color,...style}});
  }
  private modalEntry(key:string,value:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={},scroll?:string,clip?:{top:number;bottom:number}):void{
    this.modalText.push({key,text:value,x,y,scroll,clip,style:{size,color,anchorX,anchorY,...style}});
  }
  private buttonText(key:string,label:string,x:number,y:number,width:number,height:number):void{
    this.text(key,label,x+width/2,y+height/2,Math.min(22,height*.42),GOLD,.5,.5);
  }
  private modalButtonText(key:string,label:string,x:number,y:number,width:number,height:number):void{
    this.modalEntry(key,label,x+width/2,y+height/2,Math.min(22,height*.42),GOLD,.5,.5);
  }
  /** 与原 Phaser 文本同一口径量出折行高度；只做排版，不保留文字对象。 */
  private measure(view:UiSurface,value:string,width:number,size:number):{lineHeight:number;height:number}{
    if(!value)return{lineHeight:size+5,height:0};
    const probe=view.text('测',0,0,0,size);
    const lines=wrapText(value,width,text=>probe.context.measureText(text).width);
    const lineHeight=probe.height+5;
    probe.destroy();
    return{lineHeight,height:Math.max(0,lines.length*lineHeight-5)};
  }
  render(v:UiSurface,modal:UiSurface,placeModal?:PlaceModal):void{
    this.placeModal=placeModal;this.pageText=[];this.surface=v;this.selectionMarks.clear();this.deployedMarkers.clear();this.rosterCells.clear();this.tabs.clear();
    const party=this.session.party;if(!party)return;
    const snapshot=party.snapshot(),assets=this.app.menuPanels.assets;
    // The protagonist and story members do not consume mercenary roster slots.
    const story=['player',...snapshot.members.filter(member=>member.source==='story').map(member=>member.id)];
    if(this.selected&&!this.member(this.selected)){this.selected=undefined;this.modal=undefined;}
    // 没有选中项时落在名册第一个条目（主角）上，右侧详情才有内容。
    if(!this.selected){this.selected=story[0];this.prepare(this.selected);}
    this.pageButton=v.button('',9,-4,56,56,()=>this.switchRosterPage(),
      {image:assets[`party-page-${this.page+1}`]}).setData('label',`佣兵名册第 ${this.page+1} 页，切换页面`);
    story.forEach((id,index)=>{
      const button=v.button('',6,80+index*91,52,65,()=>this.select(id),{bare:true}).setData('label',this.name(id));
      v.imageCover(this.portrait(id),0,0,52,58,button,.5,.2).setAlpha(this.member(id)!.player.health>0?1:.45);
      this.text(`story-role-${id}`,id==='player'?'主角':snapshot.active.includes(id)?'上阵':'候补',6+26,80+index*91+63,16,GOLD,.5,0);
      const selected=v.rect(0,0,52,58,0xffda88,.12,button).setStrokeStyle(2,0xffda88).setVisible(this.selected===id);this.selectionMarks.set(id,selected);
    });
    this.renderRoster(v);
    const id=this.selected,member=id?this.member(id):undefined;
    // 原版佣兵页只调 `UI_DrawBorderRect`（`UIMercenary_Draw @0x151ae4`），不铺底：
    // 面板里露出的是黑色 65% 遮罩下的世界画面。
    v.border(assets,482,0,409,431);
    // 面板里那条压暗的圆角带：`UIMercenary_Draw @0x151ae4` 画在 `(x+34, y+136, 341, 101)`、强度 50。
    let bandStart=v.root.list.length;
    drawRoundBand(v,assets,516,136,341,101,50);
    this.bands.plain=v.root.list.slice(bandStart);
    bandStart=v.root.list.length;
    drawRoundBand(v,assets,516,136,341,101,50,{x:623,y:124,width:127,height:114});
    this.bands.equipment=v.root.list.slice(bandStart);
    this.bands.plain.forEach(node=>node.setVisible(this.tab!=='equipment'));
    this.bands.equipment.forEach(node=>node.setVisible(this.tab==='equipment'));
    (['info','equipment','skills'] as const).forEach((tab,index)=>{
      const button=v.button('',882,33+index*117,50,130,()=>this.switchTab(tab),
        {image:assets[`party-tab-${tab}`],disabled:!member}).setData('label',{info:'人物能力',equipment:'装备',skills:'技能目录'}[tab]);
      button.setAlpha(!member ? .4 : this.tab===tab ? 1 : .55);this.tabs.set(tab,button);
    });
    this.rosterTextCount=this.pageText.length;this.renderSelected(v);
    if(this.modal)this.renderModal(modal);
  }
  private renderRoster(v:UiSurface):void{
    const snapshot=this.session.party!.snapshot(),assets=this.app.menuPanels.assets;
    for(let index=0;index<ROSTER_SLOTS_PER_PAGE;index++){
      const id=snapshot.rosterSlots[this.page*ROSTER_SLOTS_PER_PAGE+index]??undefined,x=70+index%ROSTER_COLUMNS*136,y=5+Math.floor(index/ROSTER_COLUMNS)*123;
      let cell=this.rosterCells.get(index);
      if(cell&&cell.id!==id){
        cell.button.destroy();if(cell.id){this.selectionMarks.delete(cell.id);this.deployedMarkers.delete(cell.id);}cell=undefined;
      }
      if(!cell){
        const button=v.button('',x,y,127,114,()=>{if(id)this.select(id);},{bare:true});
        v.image(assets['party-slot'],0,0,127,114,button);
        const portrait=v.imageCover(id?this.portrait(id):assets['party-empty'],0,0,127,114,button,.5,.2);
        v.image(assets['party-frame'],-7,-7,141,128,button);
        if(id){this.selectionMarks.set(id,v.image(assets['party-selected'],-7,-7,141,128,button));
          this.deployedMarkers.set(id,v.image(assets['party-deployed'],68,54,78,64,button));}
        cell={id,button,portrait};this.rosterCells.set(index,cell);
      }
      cell.button.setData('label',id?this.name(id):`空佣兵槽 ${this.page*ROSTER_SLOTS_PER_PAGE+index+1}`);
      const dead=!!id&&this.member(id)!.player.health<=0;cell.portrait.setAlpha(dead?.45:1);
      if(dead)this.text(`roster-dead-${index}`,'阵亡',x+63,y+88,18,TEXT_COLORS.dangerSoft,.5,0);
      if(id){this.selectionMarks.get(id)?.setVisible(id===this.selected);this.deployedMarkers.get(id)?.setVisible(snapshot.active.includes(id));}
    }
    v.pruneDestroyed();
  }
  private switchRosterPage():void{this.page=1-this.page;this.refreshRoster();}
  private refreshRoster():void{
    const v=this.surface;if(!v){this.selected=undefined;this.changed();return;}
    if(this.selected)this.selectionMarks.get(this.selected)?.setVisible(false);
    this.selected='player';this.modal=undefined;this.error='';
    this.pageText.length=this.rosterTextCount;this.pageText=this.pageText.filter(spec=>!spec.key.startsWith('roster-dead-'));
    this.renderRoster(v);this.rosterTextCount=this.pageText.length;this.selectionMarks.get('player')?.setVisible(true);
    const face=this.pageButton?.getData('face') as UiImage|undefined,pageImage=this.app.menuPanels.assets[`party-page-${this.page+1}`];
    if(face&&face.getData('file')!==pageImage)face.load(pageImage);
    this.pageButton?.setData('label',`佣兵名册第 ${this.page+1} 页，切换页面`);
    this.updatePartyState();this.prepare('player');
  }
  private updatePartyState():void{
    const surface=this.surface,party=this.session.party;if(!surface||!party){this.changed();return;}
    const snapshot=party.snapshot();
    for(const [id,marker] of this.deployedMarkers)marker.setVisible(snapshot.active.includes(id));
    for(const spec of this.pageText)if(spec.key.startsWith('story-role-')){
      const id=spec.key.slice('story-role-'.length);spec.text=id==='player'?'主角':snapshot.active.includes(id)?'上阵':'候补';
    }
    for(const node of this.detailNodes)node.destroy();this.detailNodes=[];
    if(this.skillsScroll){this.removeScroll(this.skillsScroll);this.skillsScroll=undefined;}
    this.preview?.detach();this.previewSlot=undefined;surface.pruneDestroyed();
    this.pageText.length=this.rosterTextCount;this.renderSelected(surface);this.updateSelection();
  }
  private switchTab(tab:DetailTab):void{
    if(this.tab===tab)return;
    this.tab=tab;this.skillsOffset=0;
    for(const [name,button] of this.tabs)button.setAlpha(name===tab?1:.55);
    this.bands.plain.forEach(node=>node.setVisible(tab!=='equipment'));
    this.bands.equipment.forEach(node=>node.setVisible(tab==='equipment'));
    const surface=this.surface;if(!surface){this.changed();return;}
    for(const node of this.detailNodes)node.destroy();this.detailNodes=[];
    if(this.skillsScroll){this.removeScroll(this.skillsScroll);this.skillsScroll=undefined;}
    this.preview?.detach();this.previewSlot=undefined;surface.pruneDestroyed();
    this.pageText.length=this.rosterTextCount;this.renderSelected(surface);this.updateSelection();
  }
  private renderSelected(v:UiSurface):void{
    const before=new Set(v.root.list),id=this.selected,member=id?this.member(id):undefined,party=this.session.party!;
    if(id&&member){
      if(this.tab==='info')this.renderInfo(v,id);
      else if(this.tab==='equipment')this.renderEquipment(v,id);
      else this.renderSkills(v,id);
      if(id!=='player'){
        const snapshot=party.snapshot(),deployed=snapshot.active.includes(id);
        this.menuButton(v,'deployed',deployed?'移出队伍':'加入队伍',70,
          ()=>this.run(()=>deployed?party.reserve(id):party.deployFirstAvailable(id)),deployed?member.player.health<=0:snapshot.active.length>=ACTIVE_PARTY_SLOT_COUNT||member.player.health<=0);
        if((member as CompanionMember).source==='mercenary')
          this.menuButton(v,'dismiss','放逐',272,()=>{this.modal={kind:'dismiss',id};this.modalChanged();},deployed);
      }
    }
    if(this.error)this.text('error',this.error,70,434,18,TEXT_COLORS.dangerSoft,0,0,{width:808,wrap:'word'});
    this.detailNodes=v.root.list.filter(node=>!before.has(node));
  }
  /** 底部动作按钮；文字单独写进 DOM，按钮本身只保留图框和命中区。 */
  private menuButton(v:UiSurface,key:'deployed'|'dismiss',label:string,x:number,action:()=>void,disabled:boolean):void{
    v.button('',x,374,197,52,action,{disabled}).setData('label',label);
    this.buttonText(`action-${key}`,label,x,374,197,52);
  }
  private renderInfo(v:UiSurface,id:string):void{
    const member=this.member(id)!,character=this.app.storyClasses.classes.find(c=>c.id===member.classId)!,panels=this.app.menuPanels;
    this.text('info-level',`Lv. ${member.level}`,686,21,21,GOLD,.5,0);
    this.text('info-class',character.name,686,49,21,GOLD,.5,0);
    this.text('info-name',this.name(id),686,78,25,GOLD,.5,0,{width:350,align:'center'});
    character.attributes.forEach((attribute,index)=>{
      const x=536+index%2*162,y=147+Math.floor(index/2)*28;
      this.text(`info-attribute-${index}`,attribute.name,x,y,18);
      this.text(`info-attribute-value-${index}`,String(member.panel.attributes[PRIMARY_STATS[index]]),x+138,y,18,TEXT_COLORS.white,1,0);
    });
    (['health','mana','experience'] as const).forEach((kind,index)=>{
      const resources=member.player,value=resources[kind],max=kind==='health'?resources.maxHealth:kind==='mana'?resources.maxMana:resources.nextLevelExperience;
      const y=273+index*50,ratio=max?Math.max(0,Math.min(1,value/max)):kind==='experience'?1:0;
      this.text(`info-${kind}-label`,panels.character.labels[kind],551,y+6,18,GOLD,1,0);
      v.image(panels.assets['character-gauge'],565,y,243,37);
      this.text(`info-${kind}-value`,max?`${value} / ${max}`:'已满级',687,y-18,17,GOLD,.5,0,{width:232,align:'center'});
      const fill=v.image(panels.assets[`character-${kind}-fill`],575,y+12,223,13);
      fill.setCrop(0,0,fill.width*ratio,fill.height).setVisible(ratio>0);
      this.text(`info-${kind}-percent`,`${Math.floor(ratio*100)}%`,863,y+8,16,GOLD,1,0);
    });
  }
  private renderEquipment(v:UiSurface,id:string):void{
    const panels=this.app.menuPanels,member=this.member(id)!,bag=this.session.bag,equipment=bag.equipmentFor(id);
    this.previewSlot={surface:v,parent:v.container(0,0),id};this.updatePreview();
    for(const slot of panels.equipmentSlots){
      const entry=equipment[slot.id as EquipmentSlot],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const button=v.button('',482+slot.x,slot.y,74,74,()=>this.inspect(id,'bag'),{image:slotFrameImage(this.app,this.session,instance)}).setData('label',`${slot.name}：${item?.name??'空'}`);
      v.image(item?.icon??slot.emptyIcon,item?5:13,item?5:13,item?64:48,item?64:48,button);
      updateEquipmentLock(v,button,!!instance?.locked);
    }
    v.button('',568,374,230,44,()=>this.inspect(id,'bag')).setData('label','更换装备');
    this.buttonText('equipment-change','更换装备',568,374,230,44);
    this.text('equipment-level',`Lv. ${member.level}`,686,331,20,GOLD,.5,0);
  }
  private updatePreview():void{
    const slot=this.previewSlot;if(!slot?.parent.active||slot.id!==this.selected||this.tab!=='equipment')return;
    const {surface:v,parent,id}=slot,appearance=this.app.equipmentAppearance?.(id),rect={x:623,y:124,width:127,height:114};
    this.preview?.detach();parent.removeAll(true);
    if(appearance&&this.preview&&LiveCharacterPreview.available(v.scene,appearance))this.preview.show(v,appearance,rect);
    else v.imageContain(this.portrait(id),rect.x,rect.y,rect.width,rect.height,parent);
  }
  private renderSkills(v:UiSurface,id:string):void{
    const member=this.member(id)!,panels=this.app.menuPanels,character=this.app.battleCatalog.classes.find(c=>c.id===member.classId)!;
    const configuration=id==='player'?this.session.skills:(member as CompanionMember).skills,loadout=configuration.draft(this.app.battleCatalog,member.classId);
    const companion=id==='player'?undefined:(member as CompanionMember).snapshot();
    this.skillsScroll=this.scrollArea(v,'party-skills',503,18,374,342);const scroll=this.skillsScroll;
    scroll.onScroll=()=>this.refreshText();
    // 列标题改成 DOM 文字，不再从 72×17 的烘焙图读取。
    panels.skillColumns.forEach((column,index)=>this.scrolledText(`skill-column-${index}`,column.label,
      503+index*91+36,18+8.5,14,'#9a9a9a','party-skills',{top:18,bottom:360},{anchorX:.5,anchorY:.5}));
    character.skills.forEach((skillId,index)=>{
      const skill=this.app.battleCatalog.skills[skillId],position=panels.skillPositions[index],level=loadout.levels[skillId]??0,
        available=!companion||!!companion.skillCaps[skillId]||level>0;
      const button=v.button('',position.column*91,20+position.row*89,75,75,()=>{this.modal={kind:'skill',id,skill:skillId};this.modalChanged();},
        {image:available?skill.icon:panels.assets['party-skill-unavailable'],parent:scroll.content,guard:scroll.guard}).setData('label',`${skill.name} ${available?`${level} 级`:'未开放'}`);
      button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      if(available&&level>0){
        v.image(panels.assets['skill-rank'],57,51,24,25,button);
        this.scrolledText(`skill-rank-${skillId}`,String(level),503+position.column*91+69,18+20+position.row*89+54,18,GOLD,
          'party-skills',{top:18,bottom:360},{anchorX:.5,anchorY:0});
      }else if(available)v.image(panels.assets['skill-locked'],0,0,75,75,button);
    });
    if(companion?.source==='mercenary'){
      this.scrolledText('party-group-title','佣兵团',503+309,18,17,GOLD,'party-skills',{top:18,bottom:360},{anchorX:.5,anchorY:0});
      for(let index=0;index<GROUP_SKILL_SLOTS;index++){
        const group=companion.groupSkills[index],skill=group?this.session.party!.catalog.groupSkills[group]:undefined;
        const button=v.button('',273,20+index*178,75,75,()=>{if(group){this.modal={kind:'group-skill',id,skill:group};this.modalChanged();}},
          {image:skill?.icon??panels.assets['party-skill-unavailable'],parent:scroll.content,guard:scroll.guard,disabled:!skill}).setData('label',skill?.name??'空佣兵团技能');
        button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      }
    }
    scroll.setHeight(554);scroll.scrollTop=this.skillsOffset;
    v.button('',537,374,305,44,()=>this.inspect(id,'skills')).setData('label','技能与自动战斗设置');
    this.buttonText('skills-settings','技能与自动战斗设置',537,374,305,44);
  }
  renderModal(v:UiSurface):void{
    this.modalText=[];
    const modal=this.modal;if(!modal)return;
    const member=this.member(modal.id);if(!member){this.modal=undefined;return;}
    const panels=this.app.menuPanels;
    this.placeModal?.(MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT);
    v.frame(panels.assets,0,0,MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT,1);
    if(modal.kind==='dismiss'){
      v.imageCover(this.portrait(modal.id),38,66,127,114,v.root,.5,.2);
      this.modalEntry('dismiss-title',`确定放逐 ${this.name(modal.id)}？`,196,70,25,GOLD,0,0,{width:470,wrap:'word'});
      this.modalEntry('dismiss-body','放逐后，该佣兵和其穿戴的装备将一起离开。',196,132,23,GOLD,0,0,{width:465,wrap:'word'});
      if(modal.error)this.modalEntry('dismiss-error',modal.error,35,279,22,TEXT_COLORS.dangerSoft,0,0,{width:648,wrap:'word'});
      v.button('',270,350,170,48,()=>this.cancel()).setData('label','取消');
      v.button('',480,350,190,48,()=>{
        this.modal=undefined;
        if(!this.runAction){
          try{this.session.party!.dismiss(modal.id);this.selected=undefined;}
          catch(error){modal.error=(error as Error).message;this.modal=modal;}
          this.changed();return;
        }
        try{this.runAction(()=>this.session.party!.dismiss(modal.id));this.refreshRoster();}
        catch(error){modal.error=(error as Error).message;this.modal=modal;}
        this.modalChanged();
      }).setData('label','确定');
      this.modalButtonText('dismiss-cancel','取消',270,350,170,48);
      this.modalButtonText('dismiss-confirm','确定',480,350,190,48);
      return;
    }
    if(modal.kind==='group-skill'){
      const skill=this.session.party!.catalog.groupSkills[modal.skill];
      v.image(skill.icon,35,25,75,75);
      this.modalEntry('group-skill-name',skill.name,135,30,26,GOLD,0,0,{width:550,wrap:'word'});
      this.modalEntry('group-skill-kind','佣兵团技能',135,70,21,GOLD,0,0,{width:550,wrap:'word'});
      const scroll=this.scrollArea(v,'party-modal',35,124,648,197),description=this.measure(v,skill.description,632,22);
      scroll.onScroll=()=>this.refreshText();
      this.modalEntry('group-skill-description',skill.description,35,124,22,GOLD,0,0,
        {width:632,wrap:'word',lineHeight:description.lineHeight},'party-modal',{top:124,bottom:321});
      const effectText='该佣兵留在名册中即可生效。相同的佣兵团技能只生效一次。';
      const effect=this.measure(v,effectText,632,21),effectY=124+description.height+18;
      this.modalEntry('group-skill-effect',effectText,35,effectY,21,GOLD,0,0,
        {width:632,wrap:'word',lineHeight:effect.lineHeight},'party-modal',{top:124,bottom:321});
      scroll.setHeight(description.height+18+effect.height);
      v.button('',480,350,190,48,()=>this.cancel()).setData('label','关闭');
      this.modalButtonText('group-skill-close','关闭',480,350,190,48);
      return;
    }
    const skill=skillForGrowth(this.app.battleCatalog.skills[modal.skill],memberSkillGrowth(modal.id)),configuration=modal.id==='player'?this.session.skills:(member as CompanionMember).skills;
    const level=configuration.draft(this.app.battleCatalog,member.classId).levels[skill.id]??0;
    const naturalCap=modal.id==='player'?undefined:(member as CompanionMember).snapshot().skillCaps[skill.id],
      unlocked=modal.id!=='player'&&(member as CompanionMember).skills.unlockedState()[skill.id]!==undefined,
      cap=modal.id==='player'?skill.normalMaxLevel:naturalCap??level;
    v.image(skill.icon,35,25,75,75);
    this.modalEntry('skill-name',skill.name,135,30,26,GOLD,0,0,{width:550,wrap:'word'});
    this.modalEntry('skill-level',level?(modal.id!=='player'&&(member as CompanionMember).source==='mercenary'?
      `等级 ${level} / ${skill.ranks.length}${unlocked?'（技能书解锁）':`（自然成长上限 ${naturalCap}）`}`:`等级 ${level} / ${cap}`):cap?'尚未习得':'该佣兵未开放此技能',135,70,21,GOLD,0,0,{width:550,wrap:'word'});
    const scroll=this.scrollArea(v,'party-modal',35,124,648,197);
    scroll.onScroll=()=>this.refreshText();
    let y=0;
    const description=this.measure(v,skill.description,632,22);
    this.modalEntry('skill-description',skill.description,35,124+y,22,GOLD,0,0,
      {width:632,wrap:'word',lineHeight:description.lineHeight},'party-modal',{top:124,bottom:321});
    y+=description.height+15;
    if(level)for(const [index,entry] of skillDetailEntries(skill,skill.ranks[level-1]!).entries()){
      const rowText=`${entry.label}：${entry.text}`,row=this.measure(v,rowText,632,20);
      this.modalEntry(`skill-detail-${index}`,rowText,35,124+y,20,GOLD,0,0,
        {width:632,wrap:'word',lineHeight:row.lineHeight},'party-modal',{top:124,bottom:321});
      y+=row.height+10;
    }
    scroll.setHeight(y);
    v.button('',480,350,190,48,()=>this.cancel()).setData('label','关闭');
    this.modalButtonText('skill-close','关闭',480,350,190,48);
  }
}
