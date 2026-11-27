import Phaser from 'phaser';
import type { StoryApp } from '../app.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { createCharacter } from '../rendering/characters.ts';
import type { GameUI, GameUiView } from '../ui/game-ui.ts';
import type { DialoguePage } from '../ui/dialogue-text.ts';
import { FormalUiView } from '../ui/formal-ui-view.ts';
import { SceneUiAssets } from '../ui/ui-asset-host.ts';

/** 正式界面场景只连接引擎生命周期、全局输入与显示组件。 */
export class FormalUiScene extends Phaser.Scene implements GameUiView {
  private readonly app:StoryApp;
  private readonly uiAssets=new SceneUiAssets();
  private uiAssetsBound=false;
  private view?:FormalUiView;
  private readonly bridgeKey=(event:KeyboardEvent):void=>{this.app.inputRouter.dispatch(event);};
  constructor(app:StoryApp){super(SCENE_KEYS.formalUi);this.app=app;}
  create():void{
    if(!this.uiAssetsBound){this.uiAssetsBound=true;this.events.once(Phaser.Scenes.Events.DESTROY,()=>this.uiAssets.releaseResident());}
    const view=new FormalUiView(this,this.app,this.uiAssets);this.view=view;
    this.app.ui.view=this;this.app.uiAssets=this.uiAssets;
    const resize=()=>view.resize(),cancel=()=>this.app.ui.resetInput();
    this.scale.on('resize',resize);
    window.addEventListener('keydown',this.bridgeKey);
    const unregister=this.app.inputRouter.register('modal',event=>view.key(event),{
      active:()=>this.app.ui.mode==='game',
      exclusive:()=>this.app.ui.suspended||this.app.ui.worldRebuildCover||this.app.ui.defeated
        ||!!this.app.ui.quest||!!this.app.ui.loadingState||!!this.app.ui.choices
    });
    this.game.canvas.addEventListener('pointercancel',cancel);
    this.events.once('shutdown',()=>{
      this.scale.off('resize',resize);unregister();window.removeEventListener('keydown',this.bridgeKey);
      this.game.canvas.removeEventListener('pointercancel',cancel);view.destroy();
      if(this.view===view)this.view=undefined;
      if(this.app.ui.view===this)this.app.ui.view=undefined;
    });
    view.create();
    this.app.storyUI.attach(this,actor=>createCharacter(this,actor,{id:'menu-preview',actor:actor.id,x:0,y:0}));
  }
  resetInput():void{this.view?.resetInput();}
  sync(ui:GameUI):void{this.view?.sync(ui);}
  renderText(ui:GameUI):void{this.view?.renderText(ui);}
  paginate(ui:GameUI,text:string):DialoguePage[]{return this.view?.paginate(ui,text)??[];}
  portrait(file:string,signal?:AbortSignal):Promise<void>{return this.view?.portrait(file,signal)??Promise.resolve();}
  preloadPortraits(files:string[],signal:AbortSignal,progress:(value:number)=>void):Promise<void>{return this.view?.preloadPortraits(files,signal,progress)??this.uiAssets.preloadFiles(files,signal,progress);}
  override update(_time:number,delta:number):void{this.app.ui.tick(delta);this.view?.update();}
}
