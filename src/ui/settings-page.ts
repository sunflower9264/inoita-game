import { UiNode } from './dom/node.ts';
import { displaySettings } from '../application/display-settings.ts';
import { fullscreenActive, fullscreenStatus, setFullscreen } from '../application/fullscreen.ts';
import { controlSettings, nextControlMode, type ControlMode } from '../application/control-settings.ts';
import type { StoryUIContext } from '../application/ports.ts';
import { GOLD, UiSurface, type ScrollArea } from './widgets.ts';
import { MenuTextLayer, type MenuTextWriter } from './dom/menu-text.ts';

const CONTROL_MODE_LABELS:Record<ControlMode,string>={stick:'虚拟摇杆',dpad:'十字按键',keyboard:'电脑模式'};
const volumeText=(value:number):string=>value<=0?'关闭':`${Math.round(value*100)}%`;
interface SettingsPageHost {
 readonly body:UiSurface|undefined;
 readonly menuText:MenuTextLayer|undefined;
 scroll(name:string,x:number,y:number,width:number,height:number):ScrollArea;
 finishScroll(name:string,scroll:ScrollArea,height:number):void;
 openKeyBindingEditor():void;
 openControlEditor():void;
}
export class SettingsPage {
 private readonly app:Pick<StoryUIContext,'audio'>;
 private readonly host:SettingsPageHost;
 private settingsFullscreenButton?:UiNode;
 constructor(app:Pick<StoryUIContext,'audio'>,host:SettingsPageHost){this.app=app;this.host=host;}
 syncFullscreen():void{this.settingsFullscreenButton?.setData('label',`全屏：${fullscreenActive()?'开启':'关闭'}`);this.host.menuText?.renderPage('settings');}
 destroy():void{this.settingsFullscreenButton=undefined;}

  render():void{
    const v=this.host.body!,audio=this.app.audio;
    const scroll=this.host.scroll('settings',0,0,960,431),content=scroll.content;
    if(audio)for(const [index,[channel]]of [['music'],['effects']].entries()){
      const key=channel as 'music'|'effects',top=80+index*90;
      // 最左边是静音；轨道一直伸到右侧面板边缘，百分比放在轨道右端。
      // 数值文字走 DOM，拖动时直接改那一枚标签，不触发整页重绘。
      const slider=v.slider(key,485,top+33,400,audio.settings[key],value=>{
        audio.setVolume(key,value);
        this.host.menuText?.setText('settings',`${key}-value`,volumeText(value));
      },content);
      void slider;
    }
    // 帧率显示和音量一样是画面/声音偏好，放在同一个面板里；默认开启。
    const fpsButton=v.button('',485,260,220,66,()=>{
      displaySettings.setFps(!displaySettings.fps);
      fpsButton.setData('label',displaySettings.fps?'开启':'关闭');
      this.host.menuText?.renderPage('settings');
    },{parent:content}).setData('label',displaySettings.fps?'开启':'关闭');
    const frameRateLimit=displaySettings.frameRateLimit;
    const frameRateButtons:UiNode[]=[];
    for(const [index,limit] of ([30,60] as const).entries()){
      frameRateButtons.push(v.button('',485+index*230,350,220,66,()=>{
        displaySettings.setFrameRateLimit(limit);
        frameRateButtons.forEach((button,i)=>button.getData('setSelected')(i===index));
      },{parent:content,selected:frameRateLimit===limit}).setData('label',`${limit} 帧`));
    }
    // 画面精度：实际倍率不会超过本机 DPR；默认 1×，高分屏可手动开 2×/3×。
    const renderScale=displaySettings.renderScale;
    const scaleButtons:UiNode[]=[];
    for(const scale of ([1,2,3] as const)){
      scaleButtons.push(v.button('',485+(scale-1)*140,440,120,66,()=>{
        displaySettings.setRenderScale(scale);
        scaleButtons.forEach((button,index)=>button.getData('setSelected')(index+1===scale));
      },{parent:content,selected:renderScale===scale}).setData('label',`${scale}×`));
    }
    // 纹理批次：自动时安卓单纹理，iOS 和桌面多纹理；单纹理更保守。
    const batching=displaySettings.textureBatching;
    const batchingLabel={auto:'自动',multi:'多纹理',single:'单纹理'}[batching];
    const batchingButton=v.button('',485,530,260,66,()=>{
      const current=displaySettings.textureBatching;
      displaySettings.setTextureBatching(current==='auto'?'multi':current==='multi'?'single':'auto');
      batchingButton.setData('label',`纹理批次：${{auto:'自动',multi:'多纹理',single:'单纹理'}[displaySettings.textureBatching]}`);
      this.host.menuText?.renderPage('settings');
    },{parent:content}).setData('label',`纹理批次：${batchingLabel}`);
    // 暴击光环和爆闪只影响画面，默认开启；不影响暴击冲击、数字、震屏或音效。
    const decorations=displaySettings.criticalDecorations;
    const decorationsButton=v.button('',485,620,220,66,()=>{
      displaySettings.setCriticalDecorations(!displaySettings.criticalDecorations);
      decorationsButton.setData('label',displaySettings.criticalDecorations?'开启':'关闭');
      this.host.menuText?.renderPage('settings');
    },{parent:content}).setData('label',decorations?'开启':'关闭');
    // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
    let rowTop=710;
    const fullscreen=fullscreenStatus();
    if(fullscreen==='available'){
      const active=fullscreenActive();
      this.settingsFullscreenButton=v.button('',485,rowTop,220,66,()=>setFullscreen(!fullscreenActive()),{parent:content})
        .setData('label','全屏：' + (active?'开启':'关闭'));
    }else{
      this.settingsFullscreenButton=undefined;
      const label=fullscreen==='packaged'?'已全屏':'不支持';
      v.button('',485,rowTop,220,66,()=>{},{parent:content,disabled:true})
        .setData('label','全屏：'+label);
    }
    // 操作方式在本行点击轮换；触屏模式拖动控件位置，电脑模式改成键位映射。
    rowTop+=90;
    const modeLabel=CONTROL_MODE_LABELS[controlSettings.mode];
    const modeButton=v.button('',485,rowTop,220,66,()=>{
      controlSettings.setMode(nextControlMode(controlSettings.mode));
      modeButton.setData('label',`操作方式：${CONTROL_MODE_LABELS[controlSettings.mode]}`);
      actionButton.setData('label',controlSettings.mode==='keyboard'?'修改键位':'拖动调整');
      this.host.menuText?.renderPage('settings');
    },{parent:content}).setData('label',`操作方式：${modeLabel}`);
    rowTop+=90;
    const actionButton=v.button('',485,rowTop,220,66,()=>{
      if(controlSettings.mode==='keyboard')this.host.openKeyBindingEditor();
      else this.host.openControlEditor();
    },{parent:content}).setData('label',controlSettings.mode==='keyboard'?'修改键位':'拖动调整');
    this.host.finishScroll('settings',scroll,rowTop+80);
    // 滚动时 DOM 文字跟着内容移动，并裁掉视口外的行。
    this.host.menuText?.renderPage('settings');
  }
  renderText(writer:MenuTextWriter):void{
    const audio=this.app.audio;
    const add=(key:string,value:string,x:number,y:number,size:number,anchorX=0,anchorY=0):void=>
      writer.add({key,text:value,x,y,style:{size,color:GOLD,anchorX,anchorY},scroll:'settings',clip:{top:0,bottom:431}});
    add('title','环境设置',473,15,29,.5,0);
    if(audio)for(const [index,[channel,label]]of [['music','音乐'],['effects','音效']].entries()){
      const key=channel as 'music'|'effects',top=80+index*90;
      add(`${key}-label`,label,260,top+15,25);
      add(`${key}-value`,volumeText(audio.settings[key]),903,top+33,18,0,.5);
    }
    add('fps-label','帧率显示',260,275,25);
    add('fps-toggle',displaySettings.fps?'开启':'关闭',595,293,22,.5,.5);
    add('frame-rate-label','帧率上限',260,365,25);
    add('frame-rate-30','30 帧',595,383,22,.5,.5);
    add('frame-rate-60','60 帧',825,383,22,.5,.5);
    add('render-scale-label','画面精度',260,455,25);
    for(const scale of ([1,2,3] as const))add(`render-scale-${scale}`,`${scale}×`,545+(scale-1)*140,473,22,.5,.5);
    add('render-scale-hint','数字越大越清晰，最高到屏幕',260,490,16);
    const batchingLabel={auto:'自动',multi:'多纹理',single:'单纹理'}[displaySettings.textureBatching];
    add('texture-batching-label','纹理批次',260,545,25);
    add('texture-batching-toggle',batchingLabel,615,563,22,.5,.5);
    add('critical-label','暴击光效',260,635,25);
    add('critical-toggle',displaySettings.criticalDecorations?'开启':'关闭',595,653,22,.5,.5);
    let rowTop=710;
    add('fullscreen-label','全屏',260,rowTop+15,25);
    const fullscreen=fullscreenStatus();
    add('fullscreen-toggle',fullscreen==='available'?(fullscreenActive()?'开启':'关闭'):(fullscreen==='packaged'?'已全屏':'不支持'),
      595,rowTop+33,22,.5,.5);
    rowTop+=90;
    add('control-mode-label','操作方式',260,rowTop+15,25);
    add('control-mode-toggle',CONTROL_MODE_LABELS[controlSettings.mode],595,rowTop+33,22,.5,.5);
    rowTop+=90;
    const keyboard=controlSettings.mode==='keyboard';
    add('control-action-label',keyboard?'键位设置':'控件位置',260,rowTop+15,25);
    add('control-action-toggle',keyboard?'修改键位':'拖动调整',595,rowTop+33,22,.5,.5);
  }
}
