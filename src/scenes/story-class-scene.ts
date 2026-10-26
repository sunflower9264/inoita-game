import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryClassContext } from '../application/ports.ts';
import type { StoryClass } from '../domain/story-class.ts';
import { characterAssets, createCharacter } from '../rendering/characters.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import { loadSceneAssets } from '../rendering/scene-assets.ts';
import { UiSurface, loadUiImages } from '../ui/phaser/widgets.ts';

export class StoryClassScene extends Phaser.Scene {
  private readonly app:StoryClassContext;
  private surface?:UiSurface;
  private preview?:CharacterVisual;
  private selected?:StoryClass;
  private request=new AbortController();
  constructor(app:StoryClassContext){super(SCENE_KEYS.classSelect);this.app=app;}
  create():void{
    this.request=new AbortController();this.selected=undefined;this.cameras.main.setBackgroundColor('#000000');
    this.scale.on('resize',this.layout,this);
    this.input.keyboard?.on('keydown',(event:KeyboardEvent)=>{if(this.app.suspended)return;if(event.key==='Escape')this.app.returnToMenu?.();else this.surface?.key(event);});
    this.events.once('shutdown',()=>{this.request.abort();this.scale.off('resize',this.layout,this);this.surface?.destroy();this.surface=undefined;this.preview=undefined;});
    const signal=this.request.signal;
    void this.open(signal).catch(error=>{if(!signal.aborted)this.app.ui.error((error as Error).message,()=>this.scene.restart());});
  }
  private async open(signal:AbortSignal):Promise<void>{
    const catalog=this.app.storyClasses;
    await Promise.all([
      loadUiImages(this,[catalog.background,...Object.values(catalog.assets),...catalog.classes.map(entry=>entry.icon),'/assets/ui/menus/close.png','/assets/ui/menus/close-pressed.png'],value=>{if(!signal.aborted)this.app.ui.loading('正在准备职业…',value);}).then(lease=>{if(signal.aborted){lease.release();signal.throwIfAborted();}this.events.once('shutdown',()=>lease.release());}),
      loadSceneAssets(this,catalog.classes.flatMap(entry=>characterAssets(entry.previewActor)),()=>{})
    ]);
    signal.throwIfAborted();
    this.surface=new UiSurface(this,960,640);this.choose(catalog.classes.find(entry=>entry.id===catalog.defaultClass)!);
    this.app.ui.loaded();this.app.syncLifecycle?.();this.app.prefetchStory?.();
  }
  private choose(entry:StoryClass):void{
    this.selected=entry;const view=this.surface!,catalog=this.app.storyClasses;view.clear();this.preview=undefined;
    view.image(catalog.background,80,0,800,640);view.image(catalog.assets.title,263,20,434,56);view.text(entry.name,480,31,0,28).setOrigin(.5,0);
    const guard=()=>this.app.ui.ready&&!this.app.suspended;view.enabled=guard;
    view.button('',12,16,67,67,()=>this.app.returnToMenu?.(),{image:'/assets/ui/menus/close.png',pressed:'/assets/ui/menus/close-pressed.png',guard}).setData('label','返回主菜单');
    const positions=[[37,118],[70,251],[198,313],[648,313],[776,251],[809,118]];
    catalog.classes.forEach((character,index)=>{
      const [x,y]=positions[index];const button=view.button('',x,y,116,114,()=>this.choose(character),{image:character.icon,guard}).setData('label',character.name);
      if(character.id===entry.id)view.image(catalog.assets.selected,0,0,116,114,button).setBlendMode(Phaser.BlendModes.ADD);
    });
    view.button('',334,388,292,77,()=>this.app.startStory?.(this.selected!.id),{image:catalog.assets.start,pressed:catalog.assets.startPressed,guard}).setData('label','开始游戏');
    view.rect(42,464,699,174,0x000000,.4);
    view.image(catalog.assets.descriptionTop,71,456);
    view.image(catalog.assets.panelLeft,32,455);view.image(catalog.assets.panelRight,712,455);
    const description=view.scroll(80,485,622,132);
    const body=view.text(entry.description,0,0,622,23,'#ffffff',description.content);description.setHeight(body.height);
    view.rect(767,464,151,174,0x000000,.4);
    view.image(catalog.assets.attributesTop,796,455);
    view.image(catalog.assets.panelLeft,757,454);view.image(catalog.assets.panelRight,888,454);
    entry.attributes.forEach((attribute,index)=>{view.text(attribute.name,782,482+index*28,0,22,'#989898');view.text(String(attribute.value),894,482+index*28,0,22,'#ffffff').setOrigin(1,0);});
    this.preview=createCharacter(this,entry.previewActor,{id:'class-preview',actor:entry.previewActor.id,x:480,y:290});view.root.add(this.preview.container);this.preview.container.setScale(3);
    this.layout();
  }
  private layout():void{this.surface?.layout(8);}
}
