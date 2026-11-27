import type {StoryUIContext} from '../application/ports.ts';
import type {StoryMenuPage} from './story-ui-signature.ts';
import {GOLD,type UiSurface,type ScrollArea} from './widgets.ts';
import type {MenuTextWriter} from './dom/menu-text.ts';
interface SystemPageHost {
 readonly body:UiSurface;
 navigate(page:StoryMenuPage):void;
 close():void;
 scroll(name:string,x:number,y:number,width:number,height:number):ScrollArea;
 finishScroll(name:string,scroll:ScrollArea,height:number):void;
 refresh():void;
}
export class SystemPage {
 private readonly app:Pick<StoryUIContext,'gm'|'rescuePlayer'|'ui'|'returnToMenu'>;
 private readonly host:SystemPageHost;
 constructor(app:Pick<StoryUIContext,'gm'|'rescuePlayer'|'ui'|'returnToMenu'>,host:SystemPageHost){this.app=app;this.host=host;}
 render():void {

      const actions:[string,()=>void][]=[['保存游戏',()=>this.host.navigate('save')],['读取存档',()=>this.host.navigate('load')],['设置',()=>this.host.navigate('settings')],['脱离卡死',()=>{
        const result=this.app.rescuePlayer?.();
        if(!result)this.app.ui.showInstant('当前不在游戏中');
        else if(!result.ok)this.app.ui.showInstant(`脱离卡死失败：${result.reason??'未知原因'}`);
        else if(!result.moved)this.app.ui.showInstant('当前位置正常，不需要脱离卡死');
        else this.app.ui.showInstant('已脱离卡死');
      }]];
      // 「调试」只在 GM 打开时出现；关闭时这一项根本不存在，不需要靠权限判断挡住。
      if(this.app.gm)actions.push(['调试',()=>this.host.navigate('debug')]);
      actions.push(['返回主菜单',()=>{this.host.close();this.app.returnToMenu?.();}]);
      // 动作数量会随 GM 开关变化，放进滚动区，不再压缩按钮间距。
      const scroll=this.host.scroll('system',0,0,960,431),content=scroll.content,gap=80;
      // 按钮只留底图与命中区；文字统一由 DOM 层按 action 顺序生成。
      actions.forEach(([label,action],index)=>this.host.body.button('',320,70+index*gap,300,66,action,{parent:content}).setData('label',label));
      this.host.finishScroll('system',scroll,70+(actions.length-1)*gap+66+20);
      this.host.refresh();
    
 }
 renderText(writer:MenuTextWriter):void {
   const labels=['保存游戏','读取存档','设置','脱离卡死',...(this.app.gm?['调试']:[]),'返回主菜单'];
   labels.forEach((label,index)=>writer.add({key:`system-action-${index}`,text:label,x:502,y:275+index*80,style:{size:22,color:GOLD,anchorX:.5,anchorY:.5},scroll:'system',clip:{top:172,bottom:603}}));
 }
}
