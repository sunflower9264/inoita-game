import type Phaser from 'phaser';
import type {EffectClip} from '../domain/content.ts';
import type { GroundItemSprite, ItemCatalog } from '../domain/items.ts';
import type { GroundDrop } from '../domain/ground-loot.ts';
import { effectAssets } from './combat-asset-descriptors.ts';
import type { PendingAsset } from './scene-assets.ts';

const MONEY_SPRITE:GroundItemSprite={file:'assets/ui/items/money-ground.png',width:16,height:12,anchorX:7,anchorY:4};
const textureKey=(file:string):string=>`ground:${file}`;

export function groundLootAssets(items:ItemCatalog):PendingAsset[] {
  const files=new Set([MONEY_SPRITE.file,...Object.values(items.items).map(item=>item.groundSprite.file)]);
  const clips=Object.fromEntries(Object.entries(items.items).filter(([,item])=>item.pickup).map(([id,item])=>[id,{clips:Object.fromEntries(item.pickup!.hitDrop.directions.map(direction=>[direction.name,direction.clip]))}]));
  return [...[...files].map(file=>({kind:'image' as const,key:textureKey(file),file})),...effectAssets(clips)];
}

/** Ground sprites retain their native map-pixel dimensions and drawing anchor. */
export class GroundLootView {
  private readonly visuals=new Map<string,Phaser.GameObjects.Image|Phaser.GameObjects.Container>();
  private readonly flying=new Set<string>();
  /** 当前暂停状态；值没变时不再遍历飞行掉落。 */
  private paused=false;
  private readonly createFlight:(clip:EffectClip,x:number,y:number)=>Phaser.GameObjects.Container;
  private readonly layer:Phaser.GameObjects.Layer;
  private readonly scene:Phaser.Scene;
  private readonly items:ItemCatalog;
  constructor(scene:Phaser.Scene,items:ItemCatalog,createFlight:(clip:EffectClip,x:number,y:number)=>Phaser.GameObjects.Container) {
    this.createFlight=createFlight;
    this.scene=scene;this.items=items;
    this.layer=scene.add.layer().setDepth(.3).setName('ground-loot');
  }
  sync(drops:readonly GroundDrop[]):void {
    const wanted=new Set(drops.map(drop=>drop.id));
    for(const [id,visual] of this.visuals)if(!wanted.has(id)){visual.destroy();this.visuals.delete(id);this.flying.delete(id);}
    for(const drop of drops){
      const old=this.visuals.get(drop.id);
      if(old&&this.flying.has(drop.id)===!!drop.flight)continue;
      old?.destroy();
      if(drop.flight&&drop.reward.kind==='item'){
        const clip=this.items.items[drop.reward.item].pickup!.hitDrop.directions[drop.flight.direction].clip;
        const visual=this.createFlight(clip,drop.flight.x,drop.flight.y);
        const elapsed=drop.flight.durationMs-drop.flight.remainingMs;
        for(const child of visual.list){const sprite=child as Phaser.GameObjects.Sprite;
          sprite.play({key:sprite.texture.key,startFrame:Math.min(clip.frames-1,Math.floor(elapsed*clip.frameRate/1000)),repeat:0});}
        if(this.paused)for(const child of visual.list)(child as Phaser.GameObjects.Sprite).anims.pause();
        this.layer.add(visual);this.visuals.set(drop.id,visual);this.flying.add(drop.id);continue;
      }
      const sprite=drop.reward.kind==='money'?MONEY_SPRITE:this.items.items[drop.reward.item].groundSprite;
      const visual=this.scene.add.image(drop.x,drop.y,textureKey(sprite.file))
        .setDisplayOrigin(sprite.anchorX,sprite.anchorY).setName(drop.id);
      this.layer.add(visual);this.visuals.set(drop.id,visual);this.flying.delete(drop.id);
    }
  }
  setPaused(paused:boolean):void {
    if(this.paused===paused)return;
    this.paused=paused;
    for(const [id,visual] of this.visuals)if(this.flying.has(id))
      for(const child of (visual as Phaser.GameObjects.Container).list){const sprite=child as Phaser.GameObjects.Sprite; if(paused)sprite.anims.pause();else sprite.anims.resume();}
  }
  destroy():void {this.layer.destroy();this.visuals.clear();this.flying.clear();}
}
