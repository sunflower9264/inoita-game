import {skillForGrowth,memberSkillGrowth} from '../../domain/battle.ts';
import type { StoryUIContext } from '../../application/ports.ts';
import type { Session } from '../../domain/session.ts';
import type { WorldIndex } from '../../domain/content.ts';
import type { CompanionMember, CompanionGroupEffect } from '../../domain/party.ts';
import { memberArt } from '../../domain/menu-panels.ts';
import type { EquipmentSlot } from '../../domain/items.ts';
import { PRIMARY_STATS } from '../../domain/character-stats.ts';
import { skillDetailEntries } from '../../domain/skill-display.ts';
import { CharacterPreview } from './character-preview.ts';
import type { PlaceModal } from './modal-placement.ts';
import { drawRoundBand } from './round-band.ts';
import { UiSurface, type ScrollArea } from './widgets.ts';
import { slotFrameImage } from '../slot-frame.ts';

type DetailTab = 'info'|'equipment'|'skills';
type PartyModal = {kind:'dismiss';id:string;error?:string}|{kind:'skill';id:string;skill:string}|{kind:'group-skill';id:string;skill:CompanionGroupEffect};

/** Original two-page mercenary roster, with character details kept beside the roster. */
export class PartyPanel {
  private readonly session:Session;
  private readonly world:WorldIndex;
  private readonly app:StoryUIContext;
  private readonly changed:()=>void;
  private readonly inspect:(id:string,page:'bag'|'skills')=>void;
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
  private preview?:CharacterPreview;

  constructor(session:Session,world:WorldIndex,app:StoryUIContext,changed:()=>void,
    inspect:(id:string,page:'bag'|'skills')=>void){
    this.session=session;this.world=world;this.app=app;this.changed=changed;this.inspect=inspect;
  }
  get modalOpen():boolean{return !!this.modal;}
  /** 重绘前把合成立绘摘下来，避免被页面清理销毁后无法复用。 */
  detachPreview():void{this.preview?.detach();}
  destroyPreview():void{this.preview?.destroy();this.preview=undefined;}
  close():void{this.modal=undefined;this.preparation?.abort();}
  cancel():void{this.modal=undefined;this.changed();}
  captureScroll():void{this.skillsOffset=this.skillsScroll?.scrollTop??this.skillsOffset;}
  select(id:string):void{
    const slot=this.session.party!.snapshot().rosterSlots.indexOf(id);
    if(slot>=0)this.page=Math.floor(slot/9);
    this.selected=id;this.error='';this.skillsOffset=0;this.skillsScroll=undefined;this.modal=undefined;this.changed();
    this.prepare(id);
  }
  /** 选中项的外观资源就绪后重绘；切换选择时旧请求作废。 */
  private prepare(id:string):void{
    this.preparation?.abort();const request=this.preparation=new AbortController();
    void this.app.preparePartyMember?.(id,request.signal).then(()=>{if(!request.signal.aborted)this.changed();})
      .catch(error=>{if(!request.signal.aborted){this.error=(error as Error).message;this.changed();}});
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
    this.error='';let failed=true;
    try{action();failed=false;}catch(error){this.error=(error as Error).message;}
    // 成功时队伍变更已经通过 session 通知重画过；只有失败要本地重画显示错误。
    if(failed)this.changed();
  }
  render(v:UiSurface,modal:UiSurface,placeModal?:PlaceModal):void{
    this.placeModal=placeModal;
    const party=this.session.party;if(!party)return;
    const snapshot=party.snapshot(),assets=this.app.menuPanels.assets;
    // The protagonist and story members do not consume mercenary roster slots.
    const story=['player',...snapshot.members.filter(member=>member.source==='story').map(member=>member.id)];
    if(this.selected&&!this.member(this.selected)){this.selected=undefined;this.modal=undefined;}
    // 没有选中项时落在名册第一个条目（主角）上，右侧详情才有内容。
    if(!this.selected){this.selected=story[0];this.prepare(this.selected);}
    v.button('',9,-4,56,56,()=>{this.page=1-this.page;this.selected=undefined;this.modal=undefined;this.error='';this.changed();},
      {image:assets[`party-page-${this.page+1}`]}).setData('label',`佣兵名册第 ${this.page+1} 页，切换页面`);
    story.forEach((id,index)=>{
      const button=v.button('',6,80+index*91,52,65,()=>this.select(id),{bare:true}).setData('label',this.name(id));
      v.image(this.portrait(id),0,0,52,58,button).setAlpha(this.member(id)!.player.health>0?1:.45);
      v.text(id==='player'?'主角':'伙伴',26,63,0,16,undefined,button).setOrigin(.5,0);
      if(this.selected===id)v.rect(0,0,52,58,0xffda88,.12,button).setStrokeStyle(2,0xffda88);
    });
    for(let index=0;index<9;index++){
      const id=snapshot.rosterSlots[this.page*9+index],x=70+index%3*136,y=5+Math.floor(index/3)*123;
      const button=v.button('',x,y,127,114,()=>{if(id)this.select(id);},{bare:true}).setData('label',id?this.name(id):`空佣兵槽 ${this.page*9+index+1}`);
      v.image(assets['party-slot'],0,0,127,114,button);
      const portrait=v.image(id?this.portrait(id):assets['party-empty'],0,0,127,114,button);
      if(id&&this.member(id)!.player.health<=0){portrait.setAlpha(.45);v.text('阵亡',63,88,0,18,'#e6a191',button).setOrigin(.5,0);}
      v.image(assets['party-frame'],-7,-7,141,128,button);
      if(id===this.selected)v.image(assets['party-selected'],-7,-7,141,128,button);
      if(id&&snapshot.active.includes(id))v.image(assets['party-deployed'],68,54,78,64,button);
    }
    const id=this.selected,member=id?this.member(id):undefined;
    // 原版佣兵页只调 `UI_DrawBorderRect`（`UIMercenary_Draw @0x151ae4`），不铺底：
    // 面板里露出的是黑色 65% 遮罩下的世界画面。
    v.border(assets,482,0,409,431);
    // 面板里那条压暗的圆角带：`UIMercenary_Draw @0x151ae4` 画在 `(x+34, y+136, 341, 101)`、强度 50。
    drawRoundBand(v,assets,516,136,341,101,50);
    (['info','equipment','skills'] as const).forEach((tab,index)=>{
      const button=v.button('',882,33+index*117,50,130,()=>{this.tab=tab;this.skillsOffset=0;this.skillsScroll=undefined;this.changed();},
        {image:assets[`party-tab-${tab}`],disabled:!member}).setData('label',{info:'人物能力',equipment:'装备',skills:'技能目录'}[tab]);
      button.setAlpha(!member ? .4 : this.tab===tab ? 1 : .55);
    });
    if(id&&member){
      if(this.tab==='info')this.renderInfo(v,id);
      else if(this.tab==='equipment')this.renderEquipment(v,id);
      else this.renderSkills(v,id);
      if(id!=='player'&&(member as CompanionMember).source==='mercenary'){
        const deployed=snapshot.active.includes(id);
        this.menuButton(v,deployed?'party-reserve':'party-join',deployed?'移出队伍':'加入队伍',70,
          ()=>this.run(()=>deployed?party.reserve(id):party.deployFirstAvailable(id)),deployed?member.player.health<=0:snapshot.active.length>=3||member.player.health<=0);
        this.menuButton(v,'party-dismiss','放逐',272,()=>{this.modal={kind:'dismiss',id};this.changed();},deployed);
      }
    }
    if(this.error)v.text(this.error,70,434,808,18,'#e6a191');
    if(this.modal)this.renderModal(modal);
  }
  private menuButton(v:UiSurface,image:string,label:string,x:number,action:()=>void,disabled:boolean):void{
    const button=v.button('',x,374,197,52,action,{bare:true,disabled}).setData('label',label);
    button.addAt(v.image(this.app.menuPanels.assets[image],-14,-13,225,78,button),0);
  }
  private renderInfo(v:UiSurface,id:string):void{
    const member=this.member(id)!,character=this.app.storyClasses.classes.find(c=>c.id===member.classId)!,panels=this.app.menuPanels;
    v.text(`Lv. ${member.level}`,686,21,0,21).setOrigin(.5,0);
    v.text(character.name,686,49,0,21).setOrigin(.5,0);
    v.text(this.name(id),686,78,350,25).setOrigin(.5,0);
    character.attributes.forEach((attribute,index)=>{
      const x=536+index%2*162,y=147+Math.floor(index/2)*28;
      v.text(attribute.name,x,y,0,18);v.text(String(member.panel.attributes[PRIMARY_STATS[index]]),x+138,y,0,18,'#ffffff').setOrigin(1,0);
    });
    (['health','mana','experience'] as const).forEach((kind,index)=>{
      const resources=member.player,value=resources[kind],max=kind==='health'?resources.maxHealth:kind==='mana'?resources.maxMana:resources.nextLevelExperience;
      const y=273+index*50,ratio=max?Math.max(0,Math.min(1,value/max)):kind==='experience'?1:0;
      v.text(panels.character.labels[kind],551,y+6,0,18).setOrigin(1,0);
      v.image(panels.assets['character-gauge'],565,y,243,37);
      v.text(max?`${value} / ${max}`:'已满级',687,y-18,232,17).setOrigin(.5,0);
      const fill=v.image(panels.assets[`character-${kind}-fill`],575,y+12,223,13);
      fill.setCrop(0,0,fill.width*ratio,fill.height).setVisible(ratio>0);
      v.text(`${Math.floor(ratio*100)}%`,863,y+8,0,16).setOrigin(1,0);
    });
  }
  private renderEquipment(v:UiSurface,id:string):void{
    const panels=this.app.menuPanels,member=this.member(id)!,bag=this.session.bag,equipment=bag.equipmentFor(id);
    const appearance=this.app.equipmentAppearance?.(id),clip=appearance?.clips['idle-south'],preview={x:623,y:124,width:127,height:114};
    if(appearance&&clip?.layers.every(layer=>v.scene.textures.exists(layer.key))){
      // 和背包页共用同一套合成立绘：按预览框缩放居中，换人时替换，翻页时摘下来保留缓存。
      const character=this.preview??(this.preview=new CharacterPreview(v.scene,'party-equipment-preview'));
      character.show(v,appearance,preview);
    }else v.image(this.portrait(id),preview.x,preview.y,preview.width,preview.height);
    for(const slot of panels.equipmentSlots){
      const entry=equipment[slot.id as EquipmentSlot],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const button=v.button('',482+slot.x,slot.y,74,74,()=>this.inspect(id,'bag'),{image:slotFrameImage(this.app,this.session,instance)}).setData('label',`${slot.name}：${item?.name??'空'}`);
      v.image(item?.icon??slot.emptyIcon,item?5:13,item?5:13,item?64:48,item?64:48,button);
    }
    v.button('更换装备',568,374,230,44,()=>this.inspect(id,'bag'));
    v.text(`Lv. ${member.level}`,686,331,0,20).setOrigin(.5,0);
  }
  private renderSkills(v:UiSurface,id:string):void{
    const member=this.member(id)!,panels=this.app.menuPanels,character=this.app.battleCatalog.classes.find(c=>c.id===member.classId)!;
    const configuration=id==='player'?this.session.skills:(member as CompanionMember).skills,loadout=configuration.draft(this.app.battleCatalog,member.classId);
    const companion=id==='player'?undefined:(member as CompanionMember).snapshot();
    this.skillsScroll=v.scroll(503,18,374,342);const scroll=this.skillsScroll;
    panels.skillColumns.forEach((column,index)=>v.image(column.image,index*91,0,72,17,scroll.content));
    character.skills.forEach((skillId,index)=>{
      const skill=this.app.battleCatalog.skills[skillId],position=panels.skillPositions[index],level=loadout.levels[skillId]??0,available=!companion||!!companion.skillCaps[skillId];
      const button=v.button('',position.column*91,20+position.row*89,75,75,()=>{this.modal={kind:'skill',id,skill:skillId};this.changed();},
        {image:available?skill.icon:panels.assets['party-skill-unavailable'],parent:scroll.content,guard:scroll.guard}).setData('label',`${skill.name} ${available?`${level} 级`:'未开放'}`);
      button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      if(available&&level>0){v.image(panels.assets['skill-rank'],57,51,24,25,button);v.text(String(level),69,54,0,18,undefined,button).setOrigin(.5,0);}
      else if(available)v.image(panels.assets['skill-locked'],0,0,75,75,button);
    });
    if(companion?.source==='mercenary'){
      v.text('佣兵团',309,0,0,17,undefined,scroll.content).setOrigin(.5,0);
      for(let index=0;index<2;index++){
        const group=companion.groupSkills[index],skill=group?this.session.party!.catalog.groupSkills[group]:undefined;
        const button=v.button('',273,20+index*178,75,75,()=>{if(group){this.modal={kind:'group-skill',id,skill:group};this.changed();}},
          {image:skill?.icon??panels.assets['party-skill-unavailable'],parent:scroll.content,guard:scroll.guard,disabled:!skill}).setData('label',skill?.name??'空佣兵团技能');
        button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      }
    }
    scroll.setHeight(554);scroll.scrollTop=this.skillsOffset;
    v.button('技能与自动战斗设置',537,374,305,44,()=>this.inspect(id,'skills'));
  }
  private renderModal(v:UiSurface):void{
    const modal=this.modal!,member=this.member(modal.id);if(!member){this.modal=undefined;return;}
    const panels=this.app.menuPanels;
    this.placeModal?.(718,415);
    v.frame(panels.assets,0,0,718,415);
    if(modal.kind==='dismiss'){
      v.image(this.portrait(modal.id),38,66,127,114);
      v.text(`确定放逐 ${this.name(modal.id)}？`,196,70,470,25);
      v.text('放逐后，该佣兵和其穿戴的装备将一起离开。',196,132,465,23);
      if(modal.error)v.text(modal.error,35,279,648,22,'#e6a191');
      v.button('取消',270,350,170,48,()=>this.cancel());
      v.button('确定',480,350,190,48,()=>{
        this.modal=undefined;
        try{this.session.party!.dismiss(modal.id);this.selected=undefined;}
        catch(error){modal.error=(error as Error).message;this.modal=modal;}
        this.changed();
      });
      return;
    }
    if(modal.kind==='group-skill'){
      const skill=this.session.party!.catalog.groupSkills[modal.skill];
      v.image(skill.icon,35,25,75,75);v.text(skill.name,135,30,550,26);v.text('佣兵团技能',135,70,550,21);
      const scroll=v.scroll(35,124,648,197),description=v.text(skill.description,0,0,632,22,undefined,scroll.content);
      const effect=v.text('该佣兵留在名册中即可生效。相同的佣兵团技能只生效一次。',0,description.height+18,632,21,undefined,scroll.content);
      scroll.setHeight(effect.y+effect.height);v.button('关闭',480,350,190,48,()=>this.cancel());return;
    }
    const skill=skillForGrowth(this.app.battleCatalog.skills[modal.skill],memberSkillGrowth(modal.id)),configuration=modal.id==='player'?this.session.skills:(member as CompanionMember).skills;
    const level=configuration.draft(this.app.battleCatalog,member.classId).levels[skill.id]??0;
    const cap=modal.id==='player'?skill.normalMaxLevel:(member as CompanionMember).snapshot().skillCaps[skill.id]??0;
    v.image(skill.icon,35,25,75,75);v.text(skill.name,135,30,550,26);v.text(level?`等级 ${level} / ${cap}`:cap?'尚未习得':'该佣兵未开放此技能',135,70,550,21);
    const scroll=v.scroll(35,124,648,197);let y=0;
    const text=v.text(skill.description,0,y,632,22,undefined,scroll.content);y+=text.height+15;
    if(level)for(const entry of skillDetailEntries(skill,skill.ranks[level-1]!)){const row=v.text(`${entry.label}：${entry.text}`,0,y,632,20,undefined,scroll.content);y+=row.height+10;}
    scroll.setHeight(y);v.button('关闭',480,350,190,48,()=>this.cancel());
  }
}
