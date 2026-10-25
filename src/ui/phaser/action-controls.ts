import Phaser from 'phaser';
import type { Hud } from '../../rendering/hud.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import type { ActionControlsHandlers } from '../../rendering/action-controls.ts';
import { SHORTCUT_SLOT_COUNT, type ShortcutEntry } from '../../domain/shortcut-bar.ts';
import { ControlLayoutPreferences, resolveControlLayout, type ControlId } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
export { SHORTCUT_OFFSETS, SWAP_OFFSET, PENDING_OFFSET } from '../control-layout.ts';
import { ActionPressGate } from '../action-press-gate.ts';
import { uiTexture } from './widgets.ts';
import { FONT } from '../text-style.ts';

interface ControlSize {width:number;height:number;hitRadius:number;iconSize:number}
const ATTACK_SIZE:ControlSize = {width:159,height:160,hitRadius:79.5,iconSize:0};
/** 快捷位内图的边长：技能 75、物品 64（原版消耗品位就是 64×64，见 findings/native-control-layout）。 */
export const SLOT_ICON_SIZE = 75;
export const ITEM_ICON_SIZE = 64;
const SLOT_SIZE:ControlSize = {width:94,height:94,hitRadius:40,iconSize:SLOT_ICON_SIZE};
const SWAP_SIZE:ControlSize = {width:75,height:75,hitRadius:37.5,iconSize:0};
/** 默认操作区锚点，供登记屏的装饰布局使用；控件自身位置由共用 resolver 提供。 */
export function controlPlacement(scene:Phaser.Scene,width:number,height:number):{scale:number;anchor:{x:number;y:number}} {
  const {attack}=resolveControlLayout(controlViewport(scene,width,height));
  return {scale:attack.scale,anchor:{x:attack.x/attack.scale,y:attack.y/attack.scale}};
}

/** 一格快捷位上要画什么、能不能点。技能与物品共用同一套格子，由世界场景按类型算好。 */
export interface ShortcutSlot {
  entry: ShortcutEntry | null;
  icon?: string;
  quantity: number;
  /** 技能是否满足起手条件（蓝够、有必需装备等）；物品格不看它。 */
  enabled: boolean;
  /** 物品格的恢复冷却；技能格的冷却由 `setCooldowns` 按技能编号给。 */
  cooldown?: Cooldown;
}

interface Control {container:Phaser.GameObjects.Container;pressed:Phaser.GameObjects.Image;mask:Phaser.GameObjects.Graphics;size:ControlSize;pointer:number|null;icon?:Phaser.GameObjects.Image;iconSize:number;iconKey?:string;fanState?:string;badge?:Phaser.GameObjects.Container;quantityText?:Phaser.GameObjects.Text}
export class ActionControls {
  private readonly hud:Hud;private readonly scene:Phaser.Scene;
  private readonly attack:Control;private readonly slots:Control[]=[];private readonly swap:Control;
  private page:ShortcutSlot[]=[];private cooldowns:Readonly<Record<string,Cooldown>>={};
  /** 上一次画冷却时的签名；没有冷却时每帧都不必重画。 */
  private cooldownSignature?:string;
  private readonly pressGate=new ActionPressGate();
  private readonly preferences:ControlLayoutPreferences|undefined;
  private readonly unsubscribe:()=>void;
  private viewportSize:{width:number;height:number}|undefined;
  constructor(_owner:Phaser.Scene,hud:Hud,handlers:ActionControlsHandlers,skin:ControlSkin,preferences?:ControlLayoutPreferences){
    this.hud=hud;this.scene=hud.scene;this.preferences=preferences;
    this.unsubscribe=preferences?.subscribe(()=>{if(this.viewportSize)this.layout(this.viewportSize.width,this.viewportSize.height);})??(()=>{});
    this.attack=this.circle(ATTACK_SIZE,[skin.button],skin['button-pressed'],()=>handlers.attack());
    for(let index=0;index<SHORTCUT_SLOT_COUNT;index++){
      const slot=this.circle(SLOT_SIZE,[skin['slot-shadow'],skin['slot-ring']],skin['slot-pressed'],()=>this.activate(index,handlers));
      const quantityText=this.scene.add.text(0,0,'',{fontFamily:FONT,fontSize:18,color:'#ffffff',resolution:3}).setOrigin(.5);
      slot.quantityText=quantityText;
      slot.badge=this.scene.add.container(32,23,[this.image(skin['quantity-badge'],38,40),quantityText]).setVisible(false);
      slot.container.add(slot.badge);
      this.slots.push(slot);
    }
    this.swap=this.circle(SWAP_SIZE,[skin.swap],skin['swap-pressed'],()=>handlers.swap());
    this.scene.input.on('pointerup',this.release,this);this.scene.input.on('pointerupoutside',this.release,this);this.setVisible(false);
  }
  private image(file:string,width:number,height:number):Phaser.GameObjects.Image{const texture=this.scene.textures.get(file);texture.setFilter(Phaser.Textures.FilterMode.LINEAR);return this.scene.add.image(0,0,file).setOrigin(Math.floor(width/2)/width,Math.floor(height/2)/height).setDisplaySize(width,height);}
  private circle(size:ControlSize,files:string[],pressed:string,action:()=>void):Control{
    const container=this.hud.add(this.scene.add.container(0,0));container.add(files.map(file=>this.image(file,size.width,size.height)));
    const mask=this.scene.add.graphics();const highlight=this.image(pressed,size.width,size.height).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);container.add([mask,highlight]);
    const control:Control={container,mask,pressed:highlight,size,pointer:null,iconSize:size.iconSize};container.setInteractive(new Phaser.Geom.Circle(0,0,size.hitRadius),Phaser.Geom.Circle.Contains);
    container.on('pointerdown',(p:Phaser.Input.Pointer,_x:number,_y:number,event:Phaser.Types.Input.EventData)=>{event.stopPropagation();if(!this.pressGate.press(p.id))return;control.pointer=p.id;highlight.setVisible(true);action();});return control;
  }
  /** 点一格快捷位：技能起手、物品使用，分派给场景给的两个回调。 */
  private activate(index:number,handlers:ActionControlsHandlers):void{
    const entry=this.page[index]?.entry;if(!entry)return;
    if(entry.kind==='skill')handlers.skill(entry.id);else handlers.item?.(entry.id);
  }
  private release(p:Phaser.Input.Pointer):void{this.pressGate.release(p.id);for(const control of this.all())if(control.pointer===p.id){control.pointer=null;control.pressed.setVisible(false);}}
  private all():Control[]{return[this.attack,...this.slots,this.swap];}
  resetInput():void{this.pressGate.reset();for(const control of this.all()){control.pointer=null;control.pressed.setVisible(false);}}
  /** 图标只在内容或尺寸真变了才重建；这个方法会跟着战斗帧被反复调用。 */
  private icon(control:Control,file:string|undefined,size:number):void{
    if(control.iconKey===file&&control.iconSize===size)return;
    control.iconKey=file;control.iconSize=size;control.icon?.destroy();control.icon=undefined;if(!file)return;
    const key=this.scene.textures.exists(uiTexture(file))?uiTexture(file):file;if(!this.scene.textures.exists(key))return;
    control.icon=this.image(key,size,size);control.container.addAt(control.icon,2);
  }
  /** 冷却扇形按进度重画；进度没变就跳过，所以每帧调用也不会白白重建绘制指令。 */
  private paintFan(control:Control,value:Cooldown|undefined):void{
    const active=!!value&&value.remainingMs>0;
    const progress=active?Phaser.Math.Clamp(1-value!.remainingMs/value!.durationMs,0,1):0;
    const state=active?`${progress}:${control.iconSize}`:'';
    if(control.fanState===state)return;
    control.fanState=state;control.mask.clear();
    if(!active)return;
    const radius=control.iconSize/2,start=-Math.PI/2+progress*Math.PI*2;
    // 剩余时间画成深色扇形；容器本身不再整体压暗，否则扇形 alpha 会被再乘一次。
    control.mask.fillStyle(0x000000,.55);
    if(progress<=0)control.mask.fillCircle(0,0,radius);
    else control.mask.slice(0,0,radius,start,Math.PI*1.5,false).fillPath();
    // 亮色前沿和圆环让移动端小图标也能看清剩余比例。
    if(progress>0&&progress<1){
      control.mask.lineStyle(2,0xffe6a3,.9);control.mask.beginPath();
      control.mask.moveTo(0,0);control.mask.lineTo(Math.cos(start)*radius,Math.sin(start)*radius);control.mask.strokePath();
    }
    control.mask.lineStyle(1,0xffe6a3,.45);control.mask.strokeCircle(0,0,radius-1);
  }
  private cooldownOf(slot:ShortcutSlot|undefined):Cooldown|undefined {
    const entry=slot?.entry;if(!entry)return undefined;
    return entry.kind==='skill'?this.cooldowns[entry.id]:slot!.cooldown;
  }
  /** 画当前这一组的六格：技能内图 75、物品内图 64，冷却扇形跟着各自的内图半径走。 */
  setShortcutPage(slots:readonly ShortcutSlot[]):void{
    this.page=slots.map(slot=>({...slot}));this.paint();
  }
  /** 当前操控角色的图标和冷却，编辑器只读复制值，不持有实战控件。 */
  snapshot():readonly ShortcutSlot[]{return this.page.map(slot=>{const cooldown=this.cooldownOf(slot);return {...slot,entry:slot.entry?{...slot.entry}:null,cooldown:cooldown?{...cooldown}:undefined};});}
  setCooldowns(cooldowns:Readonly<Record<string,Cooldown>>):void{
    // 冷却读数没变就不重画；没有冷却的常态下每帧都省掉一次六格扫描。
    const signature=Object.keys(cooldowns).sort().map(id=>`${id}:${cooldowns[id].remainingMs}`).join('|');
    if(signature===this.cooldownSignature)return;
    this.cooldownSignature=signature;this.cooldowns=cooldowns;this.paint();
  }
  setAttack(enabled:boolean,dimUnavailable=true):void{this.attack.container.setAlpha(enabled||!dimUnavailable?1:.4);if(this.attack.container.input)this.attack.container.input.enabled=enabled;}
  private paint():void{
    this.slots.forEach((control,index)=>{
      const slot=this.page[index];if(!slot)return;
      const isItem=slot.entry?.kind==='item';
      this.icon(control,slot.entry?slot.icon:undefined,isItem?ITEM_ICON_SIZE:SLOT_ICON_SIZE);
      control.badge?.setVisible(!!slot.entry&&isItem);
      const quantity=isItem&&slot.entry?String(slot.quantity):'';
      if(control.quantityText&&control.quantityText.text!==quantity){
        control.quantityText.setText(quantity);
        control.quantityText.setScale(Math.min(1,30/Math.max(1,control.quantityText.width),30/Math.max(1,control.quantityText.height)));
      }
      const cooldown=this.cooldownOf(slot);
      this.paintFan(control,cooldown);
      // 未就绪的格子压暗图标并停掉点击：技能看起手条件，物品看数量与冷却。
      const usable=!!slot.entry&&(cooldown?.remainingMs??0)<=0&&(isItem?slot.quantity>0:slot.enabled);
      // 冷却期间不再叠加图标压暗，只让扇形自己表示剩余时间；其它不可用原因仍压暗。
      const cooling=(cooldown?.remainingMs??0)>0;
      const dim=!!slot.entry&&!usable&&!cooling;
      control.container.setAlpha(1);
      control.icon?.setAlpha(dim ? 0.4 : 1);
      control.quantityText?.setAlpha(dim ? 0.4 : 1);
      control.badge?.setAlpha(dim ? 0.4 : 1);
      if(control.container.input)control.container.input.enabled=usable;
    });
  }
  layout(width:number,height:number):void{
    this.viewportSize={width,height};
    const positions=resolveControlLayout(controlViewport(this.scene,width,height),this.preferences?.snapshot());
    const place=(control:Control,id:ControlId)=>{const point=positions[id];control.container.setPosition(point.x,point.y).setScale(point.scale);};
    place(this.attack,'attack');
    this.slots.forEach((control,index)=>place(control,`slot-${index}` as ControlId));
    place(this.swap,'swap');
  }
  setVisible(visible:boolean):void{for(const control of this.all())this.hud.setVisible(control.container,visible);if(!visible)this.resetInput();}
  destroy():void{this.unsubscribe();this.scene.input.off('pointerup',this.release,this);this.scene.input.off('pointerupoutside',this.release,this);this.all().forEach(control=>control.container.destroy(true));}
}
