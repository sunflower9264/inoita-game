import type Phaser from 'phaser';
import type {BattleCatalog} from '../domain/battle.ts';
import type {BuffLoopFrame} from '../domain/combat-conditions.ts';
import type {CharacterVisual} from './characters.ts';
import {createEffect} from './effects.ts';

/** 持续效果随Buff计龄，独立于角色当前攻击动作；Phaser负责素材层与动画帧。 */
export class BuffLoopRenderer {
  private scene:Phaser.Scene;
  private catalog:BattleCatalog;
  private actors=new Map<string,Map<string,Phaser.GameObjects.Container>>();
  constructor(scene:Phaser.Scene,catalog:BattleCatalog){this.scene=scene;this.catalog=catalog;}
  sync(id:string,visual:CharacterVisual|undefined,frames:readonly BuffLoopFrame[]):void {
    if(!visual?.container.active){this.remove(id);return;}
    // 没有持续特效时别为每个角色建 Map/Set；已有特效仍要清掉。
    if(!frames.length){this.remove(id);return;}
    const active=this.actors.get(id)??new Map<string,Phaser.GameObjects.Container>();
    const retained=new Set<string>();
    for(const frame of frames){
      const key=`${frame.buff}:${frame.effect}`;
      retained.add(key);
      const clip=this.catalog.attackEffects[frame.effect]?.clips.default;
      if(!clip)throw new Error(`持续增益特效资源缺失：${frame.effect}`);
      let effect=active.get(key);
      if(!effect?.active){
        effect=createEffect(this.scene,clip,0,0,true).setName(`buff-loop:${frame.effect}`);
        visual.container.add(effect);active.set(key,effect);
      }
      for(const layer of effect.list as Phaser.GameObjects.Sprite[]){
        layer.anims.pause();
        const animation=layer.anims.currentAnim;
        if(animation)layer.anims.setCurrentFrame(animation.frames[frame.frameAge%clip.frames]);
      }
      visual.container.bringToTop(effect);
    }
    for(const [key,effect]of active)if(!retained.has(key)){effect.destroy();active.delete(key);}
    if(active.size)this.actors.set(id,active);else this.actors.delete(id);
  }
  remove(id:string):void {
    for(const effect of this.actors.get(id)?.values()??[])effect.destroy();
    this.actors.delete(id);
  }
  retainActors(ids:ReadonlySet<string>):void {for(const id of this.actors.keys())if(!ids.has(id))this.remove(id);}
  clear():void {for(const id of this.actors.keys())this.remove(id);}
}
