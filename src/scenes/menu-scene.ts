import { SCENE_KEYS } from '../application/scene-keys.ts';
import { controlSettings } from '../application/control-settings.ts';
import { fullscreenActive, fullscreenStatus, onFullscreenChange, setFullscreen } from '../application/fullscreen.ts';
import Phaser from 'phaser';
import type { MenuContext } from '../application/ports.ts';
import { TITLE_MESSAGE_ASSETS, titleMenuImages } from '../application/menu-images.ts';
import { UiSurface, loadUiImages, uiTexture } from '../ui/phaser/widgets.ts';
import { SAVE_BOARD, SAVE_BOARD_LAYOUT, drawSaveBoardRow, newestFirstSlots, saveBoardOrigin, saveRowTitle, type SaveBoardControl } from '../ui/phaser/save-board.ts';
import { drawNativeMessage } from '../ui/phaser/native-message.ts';
import { centerModal } from '../ui/phaser/modal-placement.ts';
import { TextPrompt } from '../ui/text-prompt.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, saveSlotLabel, type SaveSlotRef, type SlotReading } from '../domain/save-game.ts';
import type { AssetLease } from '../application/assets.ts';
import type { StoryWorldViewSnapshot } from './world-scene.ts';

const art=(name:string)=>`/assets/ui/title-menu/${name}.png`;
/** 标题页右下角展示的版本号；等用户要求时再改。 */
const GAME_VERSION='v0.0.1';
export class MenuScene extends Phaser.Scene {
  readonly app:MenuContext;
  private surface?:UiSurface;
  /** 删除确认画在它上面；底下的存档页在确认期间不接受输入。 */
  private modal?:UiSurface;
  private backdrop?:Phaser.GameObjects.Image;
  private page:'home'|'slots'|'settings'='home';
  /** 存档槽立绘的租约：每次进存档页按槽里的路径取，离开页面或关场景时释放。 */
  private slotPortraits?:AssetLease;
  private slotRequest?:AbortController;
  /** 删除确认与改名输入：与游戏内菜单同一套流程，标题页也管得了自己的存档。 */
  private deleteConfirm?:SaveSlotRef;
  private renameRef?:SaveSlotRef;
  private prompt?:TextPrompt;
  constructor(app:MenuContext){super(SCENE_KEYS.menu);this.app=app;}
  create(options:{page?:'home'|'slots'}={}):void {
    this.page='home';this.app.ui.setMode('menu');this.app.ui.loading('正在准备主菜单…');
    const controller=new AbortController();
    this.events.once('shutdown',()=>{controller.abort();this.slotRequest?.abort();this.prompt?.close();this.surface?.destroy();this.surface=undefined;this.modal?.destroy();this.modal=undefined;this.slotPortraits?.release();this.slotPortraits=undefined;this.scale.off('resize',this.layout,this);});
    this.input.keyboard?.on('keydown',(event:KeyboardEvent)=>{
      if(this.app.ui.suspended)return;
      // 改名输入框开着时键盘归它，场景不再处理按键。
      if(this.renameRef!==undefined)return;
      // 确认框打开时 Escape 只关确认框，不退出存档页。
      if(event.key==='Escape'&&this.deleteConfirm!==undefined){event.preventDefault();this.deleteConfirm=undefined;this.render();return;}
      if(event.key==='Escape'&&this.page!=='home'){this.showHome();}else this.surface?.key(event);
    });
    this.scale.on('resize',this.layout,this);
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.events.once('shutdown',onFullscreenChange(()=>{
      if(this.page==='settings'&&this.surface&&this.sys.isActive())this.render();
    }));
    void loadUiImages(this,titleMenuImages).then(lease=>{
      if(controller.signal.aborted){lease.release();return;}
      this.events.once('shutdown',()=>lease.release());
      this.backdrop=this.add.image(0,0,uiTexture(art('background'))).setOrigin(.5);
      this.surface=new UiSurface(this,1200,640);this.modal=new UiSurface(this,1024,640,200);this.prompt=new TextPrompt();
      // 确认框打开时存档页整块不响应，确认框自己也只在有确认时响应。
      this.modal.enabled=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&this.deleteConfirm!==undefined;
      this.app.ui.menuLoaded();if(options.page==='slots')this.openSlots();else this.render();this.app.syncLifecycle?.();
    },error=>{if(!controller.signal.aborted)this.app.ui.error(String(error),()=>this.scene.restart());});
  }
  /**
   * 右下角版本号；点击它切换 GM 调试模式。
   *
   * 版本号用主菜单按钮的 36 号字，直接作为点击目标，不另铺热点——它本身就很小，
   * 不需要连点防误触。打开时左下角常驻一行「调试：开」——它是状态指示，不是操作结果提示。
   * 开关关闭时这一行不存在。
   */
  private addVersion(view:UiSurface):void {
    const label=view.text(GAME_VERSION,1180,628,0,36).setOrigin(1,1);
    const gm=this.app.gmMode;if(!gm)return;
    label.setInteractive({useHandCursor:true});
    label.on('pointerdown',()=>{
      if(!this.app.ui.ready||this.app.ui.suspended||!this.sys.isActive())return;
      if(gm.toggle())void this.app.loadDebugCatalog?.().then(()=>this.render(),error=>console.error(error));
      else this.render();
    });
    if(gm.on)view.text('调试：开',8,610,0,18);
  }
  private render():void {
    const view=this.surface!;view.clear();this.modal?.clear();
    // 删除确认或改名输入开着时，存档页整块不接受输入。
    const guard=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&this.deleteConfirm===undefined&&this.renameRef===undefined;view.enabled=guard;
    const button=(label:string,x:number,y:number,w:number,h:number,action:()=>void,fontSize=36)=>view.button(label,x,y,w,h,action,{fontSize,guard});
    if(this.page==='home'){
      view.image(art('logo'),291,52,617,353);view.image(art('subtitle-left'),305,385,undefined,122);view.image(art('subtitle-right'),601,385,undefined,122);
      button('开始游戏',416,457,369,124,()=>this.openSlots());
      button('环境设置',65,472,300,92,()=>{this.page='settings';this.render();});
      view.button('挑战模式',835,472,300,92,()=>{},{fontSize:36,disabled:true});
      this.addVersion(view);
    }else{
      view.button('',28,21,78,86,()=>this.showHome(),{image:art('back'),guard}).setData('label','返回主菜单');
      if(this.page==='slots'){
        view.text('存档槽',600,20,760,49).setOrigin(.5,0);
        const assets={frame:art('slot'),empty:art('slot-empty')};
        const origin=saveBoardOrigin(view.width);
        // 自动存档固定一行置顶；它没有改名与删除。
        const auto=this.app.saves.inspect(AUTO_SAVE_SLOT),autoTitle=saveRowTitle(AUTO_SAVE_SLOT,auto);
        drawSaveBoardRow<StoryWorldViewSnapshot>(view,assets,origin,SAVE_BOARD_LAYOUT.autoTop,
          {reading:auto,action:auto.kind==='ok'?()=>this.resume(AUTO_SAVE_SLOT):undefined,label:autoTitle,title:autoTitle,auto:true});
        // 十个手动槽放进滚动区；按写入时间倒序，最新的排最前，空槽排在后面。
        const scroll=view.scroll(origin.x,SAVE_BOARD_LAYOUT.listTop,SAVE_BOARD.panelWidth,SAVE_BOARD_LAYOUT.listHeight);
        newestFirstSlots(slot=>this.app.saves.inspect(slot)).forEach((slot,index)=>{
          const ref=slot,reading=this.app.saves.inspect(ref),title=saveRowTitle(ref,reading);
          drawSaveBoardRow<StoryWorldViewSnapshot>(view,assets,{x:0,y:0},index*SAVE_BOARD.rowStep,{
            reading,label:title,title,
            action:reading.kind==='ok'?()=>this.resume(ref):reading.kind==='empty'?()=>{void this.app.enterGame?.(slot);}:undefined,
            ...this.slotControls(ref,reading),
          },scroll.content);
        });
        scroll.setHeight((MANUAL_SAVE_SLOT_COUNT-1)*SAVE_BOARD.rowStep+SAVE_BOARD.frameHeight);
      }else{
        view.text('环境设置',600,20,760,49).setOrigin(.5,0);
        view.rect(200,126,800,425,0x000000,.7);view.image(art('slot'),200,126,800,425);
        for(const [index,[channel,label]]of ([['music','背景音乐'],['effects','音效']]as const).entries()){
          view.text(label,278,190+index*100,0,34);
          const enabled=this.app.audio?.settings[channel]??true;
          button(enabled?'开':'关',510,178+index*100,190,67,()=>{this.app.audio?.setEnabled(channel,!enabled);this.render();},34).setData('label',`${label}：${enabled?'开':'关'}`);
        }
        // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
        let rowTop=378;
        view.text('全屏',278,rowTop+12,0,34);
        const fullscreen=fullscreenStatus();
        if(fullscreen==='available'){
          const active=fullscreenActive();
          button(active?'开':'关',510,rowTop,190,67,()=>setFullscreen(!active),34)
            .setData('label','全屏：'+(active?'开':'关'));
        }else{
          const label=fullscreen==='packaged'?'已全屏':'不支持';
          view.button(label,510,rowTop,190,67,()=>{},{fontSize:30,disabled:true})
            .setData('label','全屏：'+label);
        }
        rowTop+=100;
        view.text('移动方式',278,rowTop+12,0,34);
        const dpad=controlSettings.moveStyle==='dpad';
        button(dpad?'十字按键':'虚拟摇杆',510,rowTop,190,67,()=>{
          controlSettings.setMoveStyle(dpad?'stick':'dpad');
          this.render();
        },30).setData('label','移动方式：' + (dpad?'十字按键':'虚拟摇杆'));
      }
    }
    if(this.deleteConfirm!==undefined){
      const ref=this.deleteConfirm,modal=this.modal!;
      // 先按父画布的缩放放好弹层，横带才能按实际可见范围铺满屏幕。
      centerModal(modal,view,1024,640);
      drawNativeMessage(modal,TITLE_MESSAGE_ASSETS,'删除后无法恢复，确定删除这个存档？',
        ()=>this.deleteSlot(ref),()=>{this.deleteConfirm=undefined;this.render();});
    }
    this.layout();
  }
  /** 手动槽的行内控件：有效存档可改名与删除，坏档只能删；自动槽永远没有。 */
  private slotControls(ref:SaveSlotRef,reading:SlotReading<StoryWorldViewSnapshot>):{controls?:SaveBoardControl[]}{
    if(ref===AUTO_SAVE_SLOT)return {};
    // 控件用固定的槽位名（改名后仍叫「存档槽 N 删除」），行本身的标题才用自定义名字。
    const slotLabel=saveSlotLabel(ref);
    if(reading.kind==='ok')return {controls:[
      {text:'改名',label:`${slotLabel} 改名`,action:()=>this.renameSlot(ref)},
      {text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)},
    ]};
    if(reading.kind==='unreadable')return {controls:[{text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)}]};
    return {};
  }
  private requestDelete(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT||this.app.saves.inspect(ref).kind==='empty')return;
    this.deleteConfirm=ref;this.render();
  }
  private deleteSlot(ref:SaveSlotRef):void{
    try{this.app.saves.erase(ref);this.app.audio?.ui('select');}
    catch(error){console.warn('删除存档失败',error);}
    this.deleteConfirm=undefined;this.render();
  }
  /** 改名：手机系统键盘输入，只收中文、英文、数字；确认后只改摘要里的名字。 */
  private renameSlot(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    const reading=this.app.saves.inspect(ref);
    if(reading.kind!=='ok')return;
    const apply=(value:string|undefined):void=>{
      if(value!==undefined){
        try{this.app.saves.rename(ref,value);}
        catch(error){console.warn('存档改名失败',error);}
      }
      this.renameRef=undefined;this.render();
    };
    // 测试没有 DOM 输入框，直接注入一个返回值。
    if(this.app.promptText){void this.app.promptText(reading.game.summary.name??'').then(apply);return;}
    this.renameRef=ref;this.render();
    this.prompt?.show({title:'存档名称',initial:reading.game.summary.name??'',
      onConfirm:value=>apply(value),onCancel:()=>apply(undefined)});
  }
  /**
   * 存档页要按槽里的立绘路径补加载图片。先画出文字行，立绘到位后再画一次：
   * 立绘是随存档记录走的路径，旧档引用的图没了也只是少一张画，不该让标题页失败。
   */
  private openSlots():void{
    this.slotRequest?.abort();this.slotPortraits?.release();this.slotPortraits=undefined;
    this.closeDialogs();
    const request=new AbortController();this.slotRequest=request;
    this.page='slots';this.render();
    const refs:SaveSlotRef[]=[AUTO_SAVE_SLOT,...Array.from({length:MANUAL_SAVE_SLOT_COUNT},(_,slot)=>slot)];
    const portraits=[...new Set(refs.map(ref=>{
      const reading=this.app.saves.inspect(ref);
      return reading.kind==='ok'?reading.game.summary.portrait:undefined;
    }).filter((file):file is string=>!!file&&!this.textures.exists(uiTexture(file))))];
    if(!portraits.length)return;
    void loadUiImages(this,portraits).then(lease=>{
      if(request.signal.aborted||this.slotRequest!==request||!this.sys.isActive()){lease.release();return;}
      this.slotPortraits?.release();this.slotPortraits=lease;
      if(this.page==='slots')this.render();
    },()=>{});
  }
  private resume(slot:SaveSlotRef):void{
    const resume=this.app.resumeSlot;if(!resume)return;
    const request=this.slotRequest;
    void resume(slot,request?.signal).catch(error=>{
      if(!this.sys.isActive()||this.slotRequest!==request||request?.signal.aborted||error instanceof DOMException&&error.name==='AbortError')return;
      console.error(error);
      this.app.ui.error(error instanceof Error?error.message:String(error),()=>{this.app.ui.menuLoaded();this.openSlots();});
    });
  }
  private showHome():void {this.closeDialogs();this.slotRequest?.abort();this.slotPortraits?.release();this.slotPortraits=undefined;this.page='home';this.render();}
  /** 离开存档页或重进时收掉确认框与改名输入，免得残留状态一直挡住输入。 */
  private closeDialogs():void {this.deleteConfirm=undefined;this.renameRef=undefined;this.prompt?.close();}
  private layout():void {if(this.backdrop){const source=this.backdrop.texture.getSourceImage(),factor=Math.max(this.scale.width/source.width,this.scale.height/source.height);this.backdrop.setPosition(this.scale.width/2,this.scale.height/2).setScale(factor);}this.surface?.layout();if(this.surface&&this.modal&&this.deleteConfirm!==undefined)centerModal(this.modal,this.surface,1024,640);}
}
