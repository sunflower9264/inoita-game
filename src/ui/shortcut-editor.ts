import { UiNode, UiImage } from './dom/node.ts';
import { SHORTCUT_PAGE_COUNT, SHORTCUT_SLOT_COUNT, ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import { SLOT_ICON_SIZE, ITEM_ICON_SIZE, controlPlacement } from './hud/action-controls.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { CompanionMember } from '../domain/party.ts';
import { frameRect } from './viewport.ts';
import { CONTROL_SIZES, PENDING_OFFSET, resolveControlLayout, type ControlId } from './control-layout.ts';
import { controlViewport } from './viewport.ts';
import { UiSurface } from './widgets.ts';
import type { DomLabel } from './dom/dom-ui.ts';
import { TEXT_COLORS } from './text-style.ts';

const SHORTCUT_PROMPT='请选择要设置的快捷键。';
interface ShortcutEditorHost {
 readonly selectedMemberId:string;
 readonly screen:UiSurface|undefined;
 readonly prompt:DomLabel|undefined;
 acknowledge():void;
}
/** 一次快捷键登记持有自己的对象、分组和槽位节点。 */
export class ShortcutEditor {
 private readonly app:Pick<StoryUIContext,'battleCatalog'|'controlSkin'|'controlLayout'>;
 private readonly session:Session;
 private readonly host:ShortcutEditorHost;
 private shortcutEdit?:{kind:ShortcutEntry['kind'];id:string;page:number};
 private shortcutSlots:{button:UiNode;scale:number;input:number;key?:string;icon?:UiImage}[]=[];
 private busy=false;
 constructor(app:Pick<StoryUIContext,'battleCatalog'|'controlSkin'|'controlLayout'>,session:Session,host:ShortcutEditorHost){this.app=app;this.session=session;this.host=host;}
 get active():boolean{return !!this.shortcutEdit;}
 get isBusy():boolean{return this.busy;}
 open(kind:ShortcutEntry['kind'],id:string):void{this.shortcutEdit={kind,id,page:0};}
 close():void{this.shortcutEdit=undefined;this.host.screen?.clear();this.shortcutSlots=[];}
 private get selectedMemberId():string{return this.host.selectedMemberId;}

  private assignShortcut(slot:number):void{
    const edit=this.shortcutEdit;if(!edit)return;
    const current=this.shortcutBar().page(edit.page)[slot];
    // 技能槽再点一次就是取消；物品沿用原版行为，点击只重新落格。
    const same=edit.kind==='skill'&&current?.kind==='skill'&&current.id===edit.id;
    this.busy=true;
    try{this.shortcutBar().assign(edit.page,slot,same?null:{kind:edit.kind,id:edit.id});}
    finally{this.busy=false;this.host.acknowledge();}
    this.updateShortcutSlots();
  }
  private shortcutIcon(entry:ShortcutEntry):string {
    return entry.kind==='skill'?this.app.battleCatalog.skills[entry.id]?.icon:this.session!.bag.catalog.items[entry.id]?.icon;
  }
  private shortcutIconSize(entry:ShortcutEntry):number{return entry.kind==='item'?ITEM_ICON_SIZE:SLOT_ICON_SIZE;}
  render():void{
    const edit=this.shortcutEdit,screen=this.host.screen,skin=this.app.controlSkin;
    if(!edit||!screen)return;
    screen.clear();this.shortcutSlots=[];const v=screen,{scale,anchor}=controlPlacement(),positions=resolveControlLayout(controlViewport(),this.app.controlLayout.snapshot());
    // 顶部提示：原版 `GRPX_DrawStringWithFont(TEXTDATABASE[146], 屏宽/2, 110)`，白字居中。
    this.placePrompt();
    // 攻击按钮是轮盘的中心锚点，登记屏也要按当前布局画出来；只画槽位会让中间空一块。
    const attack=positions.attack,attackWidth=CONTROL_SIZES.attack.width*attack.userScale,attackHeight=CONTROL_SIZES.attack.height*attack.userScale;
    v.image(skin.button,attack.x/scale-attackWidth/2,attack.y/scale-attackHeight/2,attackWidth,attackHeight);
    // 六个圆槽：输入矩形与槽框都乘设备倍率，换组后沿用同一个槽位的尺寸。
    for(let slot=0;slot<SHORTCUT_SLOT_COUNT;slot++){const point=positions[`slot-${slot}` as ControlId],userScale=point.userScale;
      const slotFrame=CONTROL_SIZES.slot.width*userScale,input=80*userScale,slotBleed=(slotFrame-input)/2;
      const hit=v.button('',point.x/scale-input/2,point.y/scale-input/2,input,input,()=>this.assignShortcut(slot),
        {bare:true,pressed:skin['slot-pressed'],pressedRect:{x:-slotBleed,y:-slotBleed,width:slotFrame,height:slotFrame}}).setData('label',`快捷位 ${slot+1}`);
      hit.addAt(v.image(skin['slot-shadow'],-slotBleed,-slotBleed,slotFrame,slotFrame),0);hit.addAt(v.image(skin['slot-ring'],-slotBleed,-slotBleed,slotFrame,slotFrame),1);
      this.shortcutSlots.push({button:hit,scale:userScale,input});
    }
    // 换组按钮：共享交换键尺寸，动作是整组切换（`UIShortcutMenu_ButtonScrollExe @0x161368`）。
    const swapUserScale=positions.swap.userScale,swapFrame=CONTROL_SIZES.swap.width*swapUserScale;
    const swap=v.button('',positions.swap.x/scale-swapFrame/2,positions.swap.y/scale-swapFrame/2,swapFrame,swapFrame,
      ()=>{if(this.shortcutEdit){this.shortcutEdit.page=(this.shortcutEdit.page+1)%SHORTCUT_PAGE_COUNT;this.updateShortcutSlots();}},
      {bare:true,pressed:skin['swap-pressed']}).setData('label','切换技能组');
    swap.addAt(v.image(skin.swap,0,0,swapFrame,swapFrame),0);
    // 待登记的对象：原版把它画在一个单独的圆框容器里，位置见 `PENDING_OFFSET`。
    const slotFrame=CONTROL_SIZES.slot.width,size=this.shortcutIconSize(edit),icon=this.shortcutIcon(edit),pending={x:anchor.x+PENDING_OFFSET.x,y:anchor.y+PENDING_OFFSET.y};
    v.image(skin['slot-shadow'],pending.x-slotFrame/2,pending.y-slotFrame/2,slotFrame,slotFrame);
    v.image(skin['slot-ring'],pending.x-slotFrame/2,pending.y-slotFrame/2,slotFrame,slotFrame);
    if(icon)v.image(icon,pending.x-size/2,pending.y-size/2,size,size);
    this.updateShortcutSlots();
  }
  private updateShortcutSlots():void{
    const edit=this.shortcutEdit,v=this.host.screen;if(!edit||!v)return;
    const entries=this.shortcutBar().page(edit.page);
    this.shortcutSlots.forEach((slot,index)=>{
      const entry=entries[index],key=entry?`${entry.kind}:${entry.id}`:undefined;
      if(slot.key===key)return;
      slot.icon?.destroy();slot.icon=undefined;slot.key=key;
      if(entry){const icon=this.shortcutIcon(entry),size=this.shortcutIconSize(entry)*slot.scale;
        if(icon){slot.icon=v.image(icon,(slot.input-size)/2,(slot.input-size)/2,size,size);slot.button.addAt(slot.icon,2);}}
    });
  }
  placePrompt():void{
    const edit=this.shortcutEdit,screen=this.host.screen,prompt=this.host.prompt;
    if(!edit||!screen||!prompt)return;
    const {scale}=controlPlacement();
    const matrix=screen.root.getWorldTransformMatrix();
    const point=matrix.transformPoint(frameRect().width/scale/2,110);
    prompt.setText(SHORTCUT_PROMPT).setPosition(point.x,point.y)
      .setStyle({fontSize:`${26*matrix.scaleX}px`,color:TEXT_COLORS.white});
  }
  private shortcutBar():ShortcutBar {
    const bag=this.session!.bag;
    return ShortcutBar.for(bag,this.selectedMemberId,this.configuration().activeSkills(this.app.battleCatalog,this.member()!.classId),
      this.selectedMemberId==='player'?bag.catalog.startingShortcut:undefined);
  }
  private member(){return this.selectedMemberId==='player'?this.session!.hero:this.session!.party?.get(this.selectedMemberId);}
  private configuration(){return this.selectedMemberId==='player'?this.session!.skills:(this.member() as CompanionMember).skills;}
}
