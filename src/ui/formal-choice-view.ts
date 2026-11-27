import type { UiSceneHost } from './dom/node.ts';
import { surfaceScreenPoint } from './panels/modal-placement.ts';
import type { GameUI } from './game-ui.ts';
import type { DomUi, DomLabel } from './dom/dom-ui.ts';
import { UiSurface, GOLD, type ScrollArea } from './widgets.ts';
import { FONT } from './text-style.ts';
import { layoutMarkupText, type DialogueTextLayout } from './dialogue-text.ts';
import { layoutChoicePanel } from './choice-layout.ts';
const UI_LINE_SPACING=5;
/** 选项里一段 DOM 文字的固定横向位置和滚动前的纵向位置，滚动时只改纵向偏移。 */
interface ChoiceDomPlacement{label:DomLabel;x:number;y:number}
interface ChoiceDomScroll{clip:DomLabel;labels:DomLabel[];placements:ChoiceDomPlacement[];scroll?:ScrollArea;top:number;scale:number}
/** 选项面板的 DOM 文字节点池；整个场景生命周期内复用，内容变化只改文本。 */
interface ChoiceDom{prompt:DomLabel[];description:ChoiceDomScroll;list:ChoiceDomScroll}


/** 选项独立持有按钮、滚动区和文字池；其他提示变化不重建它。 */
export class FormalChoiceView {
  private readonly surface:UiSurface;
  private readonly domUi:DomUi|undefined;
  private choiceDom?:ChoiceDom;
  private reading?:{choices:NonNullable<GameUI['choices']>;description?:ScrollArea;list:ScrollArea};
  private measureCanvas?:HTMLCanvasElement;
  constructor(scene:UiSceneHost,domUi?:DomUi){this.surface=new UiSurface(scene,960,640,1000,'overlay');this.domUi=domUi;this.surface.visible(false);}
  render(choices:NonNullable<GameUI['choices']>):void{
      const previous=this.reading?.choices===choices?this.reading:undefined;
      const descriptionTop=previous?.description?.scrollTop??0,listTop=previous?.list.scrollTop??0;
      let description:ScrollArea|undefined;
      const v=this.surface;v.clear();v.layout(0);v.visible(true);this.resetChoiceDom();
      // 选项竖排：整行宽度、按钮高度按标签实际换行后的高度算，文字不会压在按钮框外。
      const left=30,width=900,optionFontSize=22;
      // 提示、说明和选项标签都按原版控制码排版：`$X` 换色、`&N` 换行；文字全部交给 DOM。
      const promptLayout=this.markupLayout(choices.prompt,24,width);
      const descriptionLayout=choices.description?this.markupLayout(choices.description,22,width):undefined;
      const optionLayouts=choices.options.map(option=>this.markupLayout(option.label,optionFontSize,width-12));
      // 行距只加在行与行之间，末行之后不再多算一截。
      const optionTextHeights=optionLayouts.map(option=>option.lines.length?option.lines.length*option.lineHeight-UI_LINE_SPACING:0);
      const layout=layoutChoicePanel({
        promptHeight:promptLayout.lines.length*promptLayout.lineHeight,
        descriptionHeight:descriptionLayout&&descriptionLayout.lines.length*descriptionLayout.lineHeight,
        optionTextHeights,
      });
      const panel=v.rect(0,layout.top,960,layout.panelHeight,0x000000,.86);v.root.sendToBack(panel);
      const dom=this.ensureChoiceDom(),domLayer=this.domUi?.layer('overlay');
      const scale=this.surfacePoint(0,0).scale;
      if(dom&&domLayer){
        let cursor=0;
        promptLayout.lines.forEach((line,index)=>line.runs.forEach(run=>{
          const point=this.surfacePoint(left+run.x,layout.promptY+index*promptLayout.lineHeight);
          this.placeChoiceLabel(dom.prompt,cursor++,domLayer,run.text,point.x,point.y,24*scale,run.key);
        }));
        this.hideChoiceLabels(dom.prompt,cursor);
      }
      if(descriptionLayout&&layout.descriptionY!==undefined&&layout.descriptionView!==undefined){
        const scroll=v.scroll(left,layout.descriptionY,width,layout.descriptionView);
        scroll.setHeight(descriptionLayout.lines.length*descriptionLayout.lineHeight);
        scroll.scrollTop=descriptionTop;description=scroll;
        if(dom){
          const origin=this.surfacePoint(left,layout.descriptionY);
          dom.description.clip.setStyle({width:`${width*scale}px`,height:`${layout.descriptionView*scale}px`})
            .setPosition(origin.x,origin.y).setVisible(true);
          dom.description.scroll=scroll;dom.description.scale=scale;dom.description.top=scroll.scrollTop;
          dom.description.placements=[];
          let cursor=0;
          descriptionLayout.lines.forEach((line,index)=>line.runs.forEach(run=>{
            const x=run.x*scale,y=index*descriptionLayout.lineHeight*scale;
            const label=this.placeChoiceLabel(dom.description.labels,cursor++,dom.description.clip.element,
              run.text,x,y-scroll.scrollTop*scale,22*scale,run.key);
            dom.description.placements.push({label,x,y});
          }));
          this.hideChoiceLabels(dom.description.labels,cursor);
          scroll.onScroll=()=>this.updateChoiceDomScroll();
        }
      }
      const list=v.scroll(left,layout.listY,width,layout.listViewport);list.setHeight(layout.contentHeight);
      list.scrollTop=listTop;this.reading={choices,description,list};
      if(dom){
        const origin=this.surfacePoint(left,layout.listY);
        dom.list.clip.setStyle({width:`${width*scale}px`,height:`${layout.listViewport*scale}px`})
          .setPosition(origin.x,origin.y).setVisible(true);
        dom.list.scroll=list;dom.list.scale=scale;dom.list.top=list.scrollTop;dom.list.placements=[];
        list.onScroll=()=>this.updateChoiceDomScroll();
      }
      let optionCursor=0;
      choices.options.forEach((option,index)=>{
        const size=layout.options[index]!;
        v.button('',0,size.y,width,size.height,()=>choices.choose(option),{parent:list.content,guard:list.guard});
        if(!dom)return;
        const optionLayout=optionLayouts[index]!,textHeight=optionLayout.lines.length?optionLayout.lines.length*optionLayout.lineHeight-UI_LINE_SPACING:0;
        const top=size.y+(size.height-textHeight)/2;
        optionLayout.lines.forEach((line,lineIndex)=>line.runs.forEach(run=>{
          const x=((width-line.width)/2+run.x)*scale;
          const y=(top+lineIndex*optionLayout.lineHeight)*scale;
          const label=this.placeChoiceLabel(dom.list.labels,optionCursor++,dom.list.clip.element,
            run.text,x,y-list.scrollTop*scale,optionFontSize*scale,run.key);
          dom.list.placements.push({label,x,y});
        }));
      });
      if(dom)this.hideChoiceLabels(dom.list.labels,optionCursor);
    this.surface.layout(0);
  }
  key(event:KeyboardEvent):boolean{return this.surface.key(event);}
  hide(current?:GameUI['choices']):void{
    if(this.reading&&this.reading.choices!==current){this.reading=undefined;this.surface.clear();}
    this.surface.visible(false);this.resetChoiceDom();
  }
  destroy():void{this.surface.destroy();this.removeChoiceDom();}
  update():void{this.updateChoiceDomScroll();}
  private surfacePoint(x:number,y:number):{x:number;y:number;scale:number}{
    return surfaceScreenPoint(this.surface,x,y);
  }
  /** 选项等非对白文本：用浏览器字体度量排版，保留色码换色和显式换行。 */
  private uiTextMetrics<T>(size:number,use:(measure:(text:string)=>number,lineHeight:number)=>T):T{
    if(typeof document==='undefined')return use(text=>text.length*size,size+UI_LINE_SPACING);
    const canvas=this.measureCanvas??=document.createElement('canvas'),context=canvas.getContext('2d');
    if(!context)return use(text=>text.length*size,size+UI_LINE_SPACING);
    context.font=`${size}px ${FONT}`;
    // 与 Phaser Text 同口径：测试串的字体上下边界加行距。
    const metrics=context.measureText('|MÃ‰qgy');
    const lineHeight=(metrics.actualBoundingBoxAscent??size*.8)+(metrics.actualBoundingBoxDescent??size*.2)+UI_LINE_SPACING;
    return use(text=>context.measureText(text).width,lineHeight);
  }
  private markupLayout(value:string,size:number,width:number):DialogueTextLayout&{lineHeight:number}{
    return this.uiTextMetrics(size,(measure,lineHeight)=>({...layoutMarkupText(value,GOLD,width,measure),lineHeight}));
  }
  /**
   * 选项的 DOM 文字容器：滚动区各包一层 `overflow:hidden`，里面的标签只按
   * “排版位置 − 滚动量”移动。标签节点只建一次，之后反复改文本和位置。
   */
  private ensureChoiceDom():ChoiceDom|undefined{
    const domUi=this.domUi;if(!domUi)return undefined;
    if(this.choiceDom)return this.choiceDom;
    const clip=()=>domUi.label('overlay','dom-label dom-choice-clip').setStyle({overflow:'hidden',pointerEvents:'none'});
    this.choiceDom={prompt:[],
      description:{clip:clip(),labels:[],placements:[],top:0,scale:1},
      list:{clip:clip(),labels:[],placements:[],top:0,scale:1}};
    return this.choiceDom;
  }
  private hideChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    for(const label of state.prompt)label.setVisible(false);
    state.description.clip.setVisible(false);
    state.list.clip.setVisible(false);
  }
  /** 重建 Phaser 面板前先断开旧滚动区；节点池保留到下次选项出现。 */
  private resetChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    state.description.scroll=undefined;state.description.placements=[];
    state.list.scroll=undefined;state.list.placements=[];
    this.hideChoiceDom();
  }
  private removeChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    state.prompt.splice(0).forEach(label=>label.remove());
    state.description.labels.splice(0).forEach(label=>label.remove());
    state.list.labels.splice(0).forEach(label=>label.remove());
    state.description.clip.remove();state.list.clip.remove();
    this.choiceDom=undefined;
  }
  private placeChoiceLabel(pool:DomLabel[],index:number,parent:HTMLElement,text:string,
    x:number,y:number,size:number,color:string):DomLabel{
    const domUi=this.domUi!;
    let label=pool[index];
    if(!label){label=domUi.label('overlay','dom-label');pool.push(label);}
    if(label.element.parentElement!==parent)parent.appendChild(label.element);
    return label.setText(text).setStyle({fontSize:`${Math.max(10,size)}px`,color}).setPosition(x,y).setVisible(true);
  }
  private hideChoiceLabels(labels:DomLabel[],used:number):void{
    for(let index=used;index<labels.length;index++)labels[index]!.setVisible(false);
  }
  /** 滚动区拖动、滚轮或键盘聚焦后，只挪纵向偏移，不重排文字。 */
  private updateChoiceDomScroll():void{
    const state=this.choiceDom;if(!state)return;
    for(const group of [state.description,state.list]){
      const scroll=group.scroll;if(!scroll)continue;
      const top=scroll.scrollTop;if(top===group.top)continue;
      group.top=top;
      for(const placement of group.placements)placement.label.setPosition(placement.x,placement.y-top*group.scale);
    }
  }
}
