import Phaser from 'phaser';
import type { Hud } from '../../rendering/hud.ts';
import type { StoryPlayerState } from '../../domain/story-interface.ts';
import type { ActiveCondition } from '../../domain/combat-conditions.ts';
import { LOGIC_FRAME_MS } from '../../domain/battle.ts';
import { buffIconBlinking,buffIconPosition,gaugeFillWidth,memberColumnLayout,memberPanelIds,targetNameAnchor,targetNameColor } from '../../domain/status-hud.ts';
import type { HudGauge,StatusHudSkin,TargetStatus } from '../../domain/status-hud.ts';
import type { PartySnapshot } from '../../domain/party.ts';
import { readSafeArea } from '../viewport.ts';
import { resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import { uiImage } from './widgets.ts';
import { FONT } from '../text-style.ts';

/** 大面板与队友列、队友面板之间的空隙，按 800×480 参考单位给，换算时只乘屏幕缩放。 */
const MEMBER_COLUMN_GAP_UNITS=10;
const MEMBER_ROW_GAP_UNITS=8;
/** 队友列最下沿与切换按钮上缘之间至少留出的空隙（参考单位）。 */
const ACTION_CONTROLS_MARGIN_UNITS=8;
type MemberValues=Pick<StoryPlayerState,'level'|'health'|'maxHealth'|'mana'|'maxMana'|'experience'|'nextLevelExperience'>;

class Gauge {
  private readonly fill:Phaser.GameObjects.Image;private readonly start:Phaser.GameObjects.Image;private readonly end:Phaser.GameObjects.Image;private readonly layout:HudGauge;
  /** 上一次写入的填充宽度；血条每帧被调和调用，宽度不变时不必重写裁剪与可见性。 */
  private width=-1;
  constructor(scene:Phaser.Scene,parent:Phaser.GameObjects.Container,skin:StatusHudSkin,kind:'health'|'mana'|'experience'|'target',layout:HudGauge){
    this.layout=layout;
    const image=(part:'start'|'fill'|'end',x:number,width:number)=>scene.add.image(x,layout.y,skin.assets[`${kind}-${part}`]).setOrigin(0).setDisplaySize(width,layout.height);
    this.fill=image('fill',layout.x+layout.fillOffset,layout.fillWidth);this.start=image('start',layout.x,layout.startWidth);this.end=image('end',layout.x+layout.fillOffset+layout.fillWidth,layout.endWidth);parent.add([this.fill,this.start,this.end]);
  }
  update(value:number,max:number):void{
    const width=gaugeFillWidth(value,max,this.layout.fillWidth);
    if(width===this.width)return;
    this.width=width;
    this.fill.setCrop(0,0,this.fill.width*width/this.layout.fillWidth,this.fill.height);this.end.setX(this.layout.x+this.layout.fillOffset+width);
    for(const image of [this.fill,this.start,this.end])image.setVisible(width>0);
  }
}

/** 大面板下方的队友信息窗口：一块面板对应一位非当前操控成员，空面板不画。 */
class MemberPanel {
  readonly container:Phaser.GameObjects.Container;
  private readonly scene:Phaser.Scene;private readonly hud:Hud;private readonly skin:StatusHudSkin;
  private readonly onSelect:(id:string)=>void;
  private readonly frame:Phaser.GameObjects.Image;private readonly portrait:Phaser.GameObjects.Image;
  private readonly level:Phaser.GameObjects.Text;private readonly gauges:Record<'health'|'mana'|'experience',Gauge>;
  private icons:Phaser.GameObjects.Image[]=[];private signature='';private contentSignature='';private visible=false;private iconSignature='';
  constructor(scene:Phaser.Scene,hud:Hud,skin:StatusHudSkin,onSelect:(id:string)=>void){
    this.scene=scene;this.hud=hud;this.skin=skin;this.onSelect=onSelect;
    const layout=skin.member;
    this.container=hud.add(scene.add.container(0,0));
    this.frame=scene.add.image(0,0,skin.assets['member-frame']).setOrigin(0).setDisplaySize(layout.width,layout.height);
    const p=layout.portrait;
    this.portrait=scene.add.image(p.x,p.y,skin.assets['member-portrait']).setOrigin(0).setDisplaySize(p.width,p.height);
    // 与大面板一致：框体压在头像之上，由框体盖住头像下缘；条和等级随后再加到最上层。
    this.container.add([this.portrait,this.frame]);
    const level=layout.level;this.level=scene.add.text(level.x+level.width/2,level.y+level.height/2,'',{fontFamily:FONT,fontSize:14,color:'#ffffff',resolution:3}).setOrigin(.5);
    this.container.add(this.level);
    this.gauges=Object.fromEntries((['health','mana','experience'] as const).map(kind=>[kind,new Gauge(scene,this.container,skin,kind,layout.gauges[kind])])) as typeof this.gauges;
    this.container.setInteractive(new Phaser.Geom.Rectangle(0,0,layout.width,layout.height),Phaser.Geom.Rectangle.Contains)
      .setData('uiAction',true);
    this.container.on('pointerup',(_pointer:Phaser.Input.Pointer,_x:number,_y:number,event:Phaser.Types.Input.EventData)=>{
      event.stopPropagation();if(this.signature)this.onClick();
    });
    this.hud.setVisible(this.container,false);
  }
  private id?:string;
  private onClick():void{if(this.id)this.onSelect(this.id);}
  /** 每帧写入成员、头像与三条槽。空成员隐藏整块。 */
  set(id:string|undefined,values:MemberValues|undefined,living:boolean,portrait?:string):void{
    const layout=this.skin.member;
    if(!id||!values){this.hud.setVisible(this.container,false);this.id=undefined;this.signature='';this.contentSignature='';return;}
    this.id=id;
    // 显隐一律走 Hud：面板容器在 Hud 的登记表里，绕过它直接改会被下一次重排翻回来。
    this.hud.setVisible(this.container,this.visible);
    // 会话每次通知都会重设全部面板；数值没变时跳过贴图、字体与槽位重写。
    const down=!living,downKey=id==='player'?this.skin.assets['player-portrait-down']:this.skin.assets['member-portrait-down'],
      portraitImage:PortraitRef=down?{key:downKey}:portraitRef(this.scene,portrait)??{key:this.skin.assets['member-portrait']};
    const content=`${id}|${values.level}|${values.health}/${values.maxHealth}|${values.mana}/${values.maxMana}|${values.experience}/${values.nextLevelExperience}|${portraitRefKey(portraitImage)}`;
    if(content===this.contentSignature)return;
    this.contentSignature=content;
    this.frame.setTexture(this.skin.assets['member-frame']).setDisplaySize(layout.width,layout.height);
    this.portrait.setTexture(portraitImage.key,portraitImage.frame);
    const p=layout.portrait;
    this.portrait.setPosition(p.x,p.y).setDisplaySize(p.width,p.height);
    const level=layout.level;
    this.level.setPosition(level.x+level.width/2,level.y+level.height/2)
      .setText(String(values.level)).setScale(Math.min(1,(level.width-4)/Math.max(1,this.level.width),(level.height-4)/Math.max(1,this.level.height)));
    this.gauges.health.update(values.health,values.maxHealth);
    this.gauges.mana.update(values.mana,values.maxMana);
    this.gauges.experience.update(values.experience,values.nextLevelExperience);
    this.container.disableInteractive().setInteractive(new Phaser.Geom.Rectangle(0,0,layout.width,layout.height),Phaser.Geom.Rectangle.Contains);
    if(!living)this.container.disableInteractive();
    this.signature=id;
  }
  /** 状态图标骑在面板左下角：第一枚在左下，之后向左每 27 像素一枚。 */
  paintIcons(conditions:readonly ActiveCondition[]):void{
    const skin=this.skin.buffIcons;if(!this.container.visible)return;
    const panelHeight=this.skin.member.height;
    const entries=conditions.filter(condition=>skin.catalog[condition.id]);
    while(this.icons.length<entries.length){const image=this.scene.add.image(0,0,'').setOrigin(0).setDisplaySize(skin.size,skin.size);this.container.add(image);this.icons.push(image);}
    const signature=entries.map(condition=>condition.id).join('|');
    if(signature!==this.iconSignature){
      this.iconSignature=signature;
      entries.forEach((condition,index)=>{
        const at=buffIconPosition(skin,panelHeight,index);
        this.icons[index].setTexture(skin.catalog[condition.id]).setPosition(at.x,at.y).setVisible(true);
      });
      for(const image of this.icons.slice(entries.length))image.setVisible(false);
    }
    // 闪烁要靠 remainingMs，每次通知都要更新；贴图/位置只在图标集合变化时重设。
    entries.forEach((condition,index)=>this.icons[index].setData('remainingMs',condition.remainingMs));
    for(const image of this.icons.slice(entries.length))image.setData('remainingMs',undefined);
  }
  /** 跟随状态面板整组显隐：对白、演出、菜单与暂停期间一起隐藏。 */
  setVisible(value:boolean):void{
    this.visible=value;
    this.hud.setVisible(this.container,value&&!!this.id);
  }
  /** 每帧按逻辑帧计数切换闪烁；进入闪烁窗口的图标在暗相隐藏，槽位保留。 */
  tick(tick:number):void{
    for(const image of this.icons){
      const remaining=image.getData('remainingMs') as number|undefined;
      if(remaining===undefined)continue;
      image.setVisible(!buffIconBlinking(Math.max(0,Math.ceil(remaining/LOGIC_FRAME_MS)),tick));
    }
  }
  destroy():void{this.container.destroy(true);}
}

interface PortraitRef{key:string;frame?:string}
const portraitRefKey=(ref:PortraitRef):string=>ref.frame?`${ref.key}\0${ref.frame}`:ref.key;
/** 状态栏皮肤按文件路径直接做纹理键；菜单面板图片可能进了 UI 图集，两种都要认。 */
function portraitRef(scene:Phaser.Scene,file:string|undefined):PortraitRef|undefined{
  if(!file)return undefined;
  const ref=uiImage(file);
  const texture=scene.textures.exists(ref.key)?scene.textures.get(ref.key):undefined;
  if(texture&&(!ref.frame||texture.has(ref.frame)))return ref;
  return scene.textures.exists(file)?{key:file}:undefined;
}

export class StatusHud {
  private readonly hud:Hud;private readonly skin:StatusHudSkin;
  private readonly playerContainer:Phaser.GameObjects.Container;private readonly targetContainer:Phaser.GameObjects.Container;
  private readonly portrait:Phaser.GameObjects.Image;private readonly level:Phaser.GameObjects.Text;private readonly name:Phaser.GameObjects.Text;
  private readonly panels:MemberPanel[];private readonly gauges:Record<'health'|'mana'|'experience',Gauge>;private readonly targetGauge:Gauge;
  private readonly playerIcons:Phaser.GameObjects.Container;
  private readonly unsubscribe:()=>void;private player?:Readonly<StoryPlayerState>;private target?:TargetStatus;private visible=false;
  private targetSignature='';private lastTick=-1;
  private partySignature='';private playerIconImages:Phaser.GameObjects.Image[]=[];private memberCount=0;
  private playerIconSignature='';private portraitKey?:string;private visibilityApplied=false;
  constructor(hud:Hud,skin:StatusHudSkin,readPlayer:()=>Readonly<StoryPlayerState>|undefined,subscribe:(listener:()=>void)=>()=>void,
    readParty?:()=>PartySnapshot|undefined,onSelect?:(id:string)=>void,portraitFor?:(id:string)=>string|undefined,onFocus?:()=>void,
    readConditions?:(id:string)=>readonly ActiveCondition[],readHero?:()=>MemberValues|undefined){
    this.hud=hud;this.skin=skin;
    const scene=hud.scene;
    Object.values(skin.assets).forEach(file=>scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR));
    Object.values(skin.buffIcons.catalog).forEach(file=>{if(scene.textures.exists(file))scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);});
    this.playerContainer=hud.add(scene.add.container(0,0));this.targetContainer=hud.add(scene.add.container(0,0));
    const image=(file:string,x:number,y:number,w:number,h:number)=>scene.add.image(x,y,file).setOrigin(0).setDisplaySize(w,h);
    this.playerContainer.add(image(skin.assets['player-shadow'],0,0,skin.player.width,skin.player.height));const p=skin.player.portrait;
    this.portrait=image(skin.assets['player-portrait'],p.x,p.y,p.width,p.height);this.playerContainer.add([this.portrait,image(skin.assets['player-frame'],0,0,skin.player.width,skin.player.height)]);
    const text=(x:number,y:number,size:number)=>scene.add.text(x,y,'',{fontFamily:FONT,fontSize:size,color:'#ffffff',resolution:3});
    const level=skin.player.level;this.level=text(level.x+level.width/2,level.y+level.height/2,17).setOrigin(.5);this.playerContainer.add(this.level);
    this.gauges=Object.fromEntries((['health','mana','experience'] as const).map(kind=>[kind,new Gauge(scene,this.playerContainer,skin,kind,skin.player.gauges[kind])])) as typeof this.gauges;
    const nameAnchor=targetNameAnchor(skin);this.name=text(nameAnchor.x,nameAnchor.y,18).setOrigin(.5,0);this.targetContainer.add(this.name);this.targetGauge=new Gauge(scene,this.targetContainer,skin,'target',skin.target.gauge);
    this.playerIcons=scene.add.container(0,0);this.playerContainer.add(this.playerIcons);
    // 点大面板找回当前操控角色；队友面板则切换操控者。
    // 点面板只走面板自己的 pointerup；世界级左键看到 `uiAction` 就不再普攻。
    this.playerContainer.setInteractive(new Phaser.Geom.Rectangle(0,0,skin.player.width,skin.player.height),Phaser.Geom.Rectangle.Contains)
      .setData('uiAction',true);
    this.playerContainer.on('pointerup',(_pointer:Phaser.Input.Pointer,_x:number,_y:number,event:Phaser.Types.Input.EventData)=>{
      event.stopPropagation();if(this.visible&&this.player)onFocus?.();
    });
    this.panels=(skin.member.slots??[]).map(()=>new MemberPanel(scene,hud,skin,id=>onSelect?.(id)));
    const refresh=()=>{
      this.player=readPlayer();const snapshot=readParty?.(),signature=JSON.stringify([snapshot?.active,snapshot?.controlled,snapshot?.living]);
      if(signature!==this.partySignature){this.partySignature=signature;}
      const active=snapshot?.active??['player'];
      const controlled=snapshot?.controlled??'player';
      // 大面板常驻当前操控者；竖排只列其余成员，按队伍顺序紧接在大面板下方。
      const others=memberPanelIds(active,controlled);
      const previousCount=this.memberCount;this.memberCount=others.length;
      others.forEach((id,index)=>{const panel=this.panels[index];if(!panel)return;
        const member=snapshot?.members.find(value=>value.id===id);
        // 队伍快照只有佣兵，主角（'player'）的数值要单独读。
        const values=id==='player'?readHero?.()??member:member;
        panel.set(id,values as MemberValues|undefined,snapshot?.living.includes(id)??true,portraitFor?.(id));});
      for(let slot=others.length;slot<this.panels.length;slot++)this.panels[slot].set(undefined,undefined,true);
      const file=portraitFor?.(controlled),ref=portraitRef(scene,file),portraitSignature=ref?portraitRefKey(ref):undefined;
      if(ref&&portraitSignature!==this.portraitKey){this.portraitKey=portraitSignature;this.portrait.setTexture(ref.key,ref.frame).setDisplaySize(p.width,p.height);}
      this.paintPlayerIcons(readConditions?.(controlled)??[]);
      this.panels.forEach((panel,index)=>panel.paintIcons(index<others.length?(readConditions?.(others[index])??[]):[]));
      if(this.player){const value=this.player;this.level.setText(String(value.level)).setScale(Math.min(1,(level.width-4)/Math.max(1,this.level.width),(level.height-4)/Math.max(1,this.level.height)));this.gauges.health.update(value.health,value.maxHealth);this.gauges.mana.update(value.mana,value.maxMana);this.gauges.experience.update(value.experience,value.nextLevelExperience);}this.paintTarget();this.syncVisibility();
      // 面板数量变了，列的缩放与位置也要跟着重算。
      if(previousCount!==this.memberCount)this.layout();
    };
    this.unsubscribe=subscribe(refresh);refresh();this.layout();
  }
  /** 每帧刷新状态图标的闪烁；逻辑帧计数与战斗时钟同源。 */
  update(tick:number):void{
    // 渲染帧比逻辑帧密，同一逻辑帧内图标相位不会变。
    if(tick===this.lastTick)return;
    this.lastTick=tick;
    for(const image of this.playerIconImages){
      const remaining=image.getData('remainingMs') as number|undefined;
      if(remaining===undefined)continue;
      image.setVisible(!buffIconBlinking(Math.max(0,Math.ceil(remaining/LOGIC_FRAME_MS)),tick));
    }
    for(const panel of this.panels)panel.tick(tick);
  }
  setTarget(target:TargetStatus|undefined):void{
    const signature=target?`${target.id}|${target.name}|${target.level}|${target.health}/${target.maxHealth}|${target.sceneLevel}|${this.player?.level??1}`:'';
    if(signature===this.targetSignature)return;
    this.targetSignature=signature;this.target=target;this.paintTarget();this.syncVisibility();
  }
  private paintTarget():void{
    if(!this.target)return;
    const target=this.target,color=targetNameColor(this.skin,this.player?.level??1,target);
    this.name.setText(`${target.name} (Lv.${target.level})`);
    // setColor 每次都会重画文字画布；颜色没变就跳过。
    if(this.name.style.color!==color)this.name.setColor(color);
    this.targetGauge.update(target.health,target.maxHealth);
  }
  private paintPlayerIcons(conditions:readonly ActiveCondition[]):void{
    const skin=this.skin.buffIcons;
    const entries=conditions.filter(condition=>condition.kind==='buff'&&skin.catalog[condition.id]);
    while(this.playerIconImages.length<entries.length){
      const image=this.hud.scene.add.image(0,0,'').setOrigin(0).setDisplaySize(skin.size,skin.size);
      this.playerIcons.add(image);this.playerIconImages.push(image);
    }
    const signature=entries.map(condition=>condition.id).join('|');
    if(signature!==this.playerIconSignature){
      this.playerIconSignature=signature;
      entries.forEach((condition,index)=>{
        const at=buffIconPosition(skin,this.skin.player.height,index);
        this.playerIconImages[index].setTexture(skin.catalog[condition.id]).setPosition(at.x,at.y).setVisible(true);
      });
      for(const image of this.playerIconImages.slice(entries.length))image.setVisible(false);
    }
    entries.forEach((condition,index)=>this.playerIconImages[index].setData('remainingMs',condition.remainingMs));
    for(const image of this.playerIconImages.slice(entries.length))image.setData('remainingMs',undefined);
  }
  layout():void{const scene=this.hud.scene,bounds=scene.game.canvas.getBoundingClientRect(),safe=readSafeArea(),unit=scene.scale.width/Math.max(1,bounds.width),size=Math.min(scene.scale.width/800,scene.scale.height/480);
    const right=scene.scale.width-safe.right*unit,top=safe.top*unit;
    // 右缘对齐以素材可见边框为准：图幅四周是透明留白，两块面板的留白并不相同。
    const playerEdge=this.skin.player.width-this.skin.player.inset.right;
    const memberEdge=this.skin.member.width-this.skin.member.inset.right;
    this.playerContainer.setScale(size).setPosition(right-playerEdge*size,top);this.targetContainer.setScale(size).setPosition((scene.scale.width-this.skin.target.width*size)/2,top);
    // 队友列从大面板下缘排到切换按钮上缘。上限按默认键位算；玩家拖动过切换按钮时不跟着重算，
    // 免得调键位时整列面板随拖动跳动。
    const swap=resolveControlLayout(controlViewport(scene,scene.scale.width,scene.scale.height)).swap;
    const column=memberColumnLayout({top,playerHeight:this.skin.player.height*size,memberHeight:this.skin.member.height,
      count:this.memberCount,limit:swap.y-swap.height/2-ACTION_CONTROLS_MARGIN_UNITS*size,size,
      columnGap:MEMBER_COLUMN_GAP_UNITS*size,rowGap:MEMBER_ROW_GAP_UNITS*size});
    // 队友面板比大面板窄，可见右缘与大面板可见右缘齐平。
    this.panels.forEach((panel,index)=>{const y=column.tops[index];if(y===undefined)return;
      panel.container.setScale(size*column.scale).setPosition(right-memberEdge*size*column.scale,y);});
  }
  setVisible(value:boolean):void{
    // 第一次必须真正应用（构造时容器默认可见）；之后同值不重复遍历面板。
    if(this.visibilityApplied&&this.visible===value)return;
    this.visibilityApplied=true;this.visible=value;this.syncVisibility();
  }
  private syncVisibility():void{
    this.hud.setVisible(this.playerContainer,this.visible&&!!this.player);
    this.hud.setVisible(this.targetContainer,this.visible&&!!this.target);
    this.panels.forEach((panel,index)=>panel.setVisible(this.visible&&index<this.memberCount));
  }
  destroy():void{this.unsubscribe();this.playerContainer.destroy(true);this.targetContainer.destroy(true);for(const panel of this.panels)panel.destroy();}
}
