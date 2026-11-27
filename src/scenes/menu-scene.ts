import Phaser from 'phaser';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import type { MenuContext } from '../application/ports.ts';
import { SceneUiAssets } from '../ui/ui-asset-host.ts';
import { TitleMenuController } from '../ui/title-menu-controller.ts';

/** 场景持有常驻素材；每次进入标题页创建独立的界面。 */
export class MenuScene extends Phaser.Scene {
  readonly app:MenuContext;
  private readonly titleAssets:SceneUiAssets;
  private assetsBound=false;
  private page?:TitleMenuController;
  constructor(app:MenuContext){super(SCENE_KEYS.menu);this.app=app;this.titleAssets=new SceneUiAssets();}
  create(options:{page?:'home'|'slots'}={}):void {
    if(!this.assetsBound){this.assetsBound=true;this.events.once(Phaser.Scenes.Events.DESTROY,()=>this.titleAssets.releaseResident());}
    const previous=this.page;
    if(previous){
      this.events.off(Phaser.Scenes.Events.RESUME,previous.renderOnResume,previous);
      this.events.off(Phaser.Scenes.Events.PAUSE,previous.hideCredentials);
      this.scale.off('resize',previous.resize,previous);
      previous.dispose();
    }
    const page=new TitleMenuController(this,this.app,this.titleAssets,()=>this.scene.restart());this.page=page;
    // 场景层负责恢复、暂停与尺寸变化；页面 controller 只处理自己的状态和 DOM。
    this.events.on(Phaser.Scenes.Events.RESUME,page.renderOnResume,page);
    this.events.on(Phaser.Scenes.Events.PAUSE,page.hideCredentials);
    this.scale.on('resize',page.resize,page);
    this.events.once('shutdown',()=>{
      this.events.off(Phaser.Scenes.Events.RESUME,page.renderOnResume,page);
      this.events.off(Phaser.Scenes.Events.PAUSE,page.hideCredentials);
      this.scale.off('resize',page.resize,page);
      page.dispose();if(this.page===page)this.page=undefined;
    });
    page.open(options);
  }
}
