import Phaser from 'phaser';
import type { BattleCatalog } from '../domain/battle.ts';
import { damageDigits, digitSequence, feedbackPlan, reusableDigit, type CombatHitFeedback, type CombatFeedbackSelection } from '../domain/combat-feedback.ts';
import type { CharacterVisual } from './characters.ts';
import { createEffect } from './effects.ts';

interface Digit {effect:Phaser.GameObjects.Container;sequence:number[]}

/** 命中反馈由地图持有，攻击动作结束或中断不提前销毁已生成的数字。 */
export class CombatFeedback {
  private readonly scene:Phaser.Scene;
  private readonly catalog:BattleCatalog;
  private readonly vibrationEnabled:boolean;
  private readonly effects=new Set<Phaser.GameObjects.Container>();
  private readonly digits:(Digit|undefined)[]=Array(32);
  private shake?:Phaser.Tweens.Tween;
  private shakeBase?:{x:number;y:number};
  private paused=false;
  private visible=true;
  constructor(scene:Phaser.Scene,catalog:BattleCatalog,vibrationEnabled=false){this.scene=scene;this.catalog=catalog;this.vibrationEnabled=vibrationEnabled;}
  private track(effect:Phaser.GameObjects.Container):void {
    this.effects.add(effect);effect.setVisible(this.visible);
    effect.once('destroy',()=>this.effects.delete(effect));
    if(this.paused)for(const sprite of effect.list as Phaser.GameObjects.Sprite[])sprite.anims.pause();
  }
  private impact(name:string,target:CharacterVisual,attached=true):void {
    const anchor=target.actor.effectAnchor??{x:0,y:0};
    const position=attached?anchor:target.container;
    const effect=createEffect(this.scene,this.catalog.attackEffects[name].clips.default,position.x,position.y);
    if(attached)target.container.addAt(effect,target.layers.length);
    else effect.setDepth(Number.MAX_SAFE_INTEGER);
    this.track(effect);
  }
  show(event:CombatHitFeedback,target:CharacterVisual,selection:CombatFeedbackSelection):void {
    const plan=feedbackPlan(event);
    for(const effect of selection.impacts)this.impact(effect.name,target,effect.attached);
    if(selection.digitEffect){
      const name=selection.digitEffect;
      for(const digit of damageDigits(event.hit.damage,event.hit.kind==='miss')){
        let slot=this.digits.findIndex(value=>!value);
        if(slot<0)slot=reusableDigit(this.digits.map(value=>{
          const sprite=value?.effect.list[0] as Phaser.GameObjects.Sprite|undefined;
          return sprite?.visible?value!.sequence[(sprite.anims.currentFrame?.index??1)-1]??0:-1;
        }));
        if(slot<0)break;
        this.digits[slot]?.effect.destroy();
        const clip=this.catalog.attackEffects[name].clips[String(digit.digit)];
        const effect=createEffect(this.scene,clip,target.container.x+digit.x,target.container.y+digit.y).setDepth(Number.MAX_SAFE_INTEGER);
        const sequence=digitSequence(clip.frames,digit.holdFrames);
        this.digits[slot]={effect,sequence};
        effect.once('destroy',()=>{if(this.digits[slot]?.effect===effect)this.digits[slot]=undefined;});
        for(const sprite of effect.list as Phaser.GameObjects.Sprite[]){
          sprite.anims.stop();
          const key='damage';
          sprite.anims.create({key,frames:sequence.map(frame=>({key:sprite.texture.key,frame})),frameRate:clip.frameRate});
          sprite.setVisible(false).play({key,delay:digit.delayMs,showOnStart:true});
        }
        this.track(effect);
      }
    }
    if(plan.shake&&this.visible)this.startShake();
  }
  startShake():void {
    if(!this.visible)return;
    this.cancelShake();
    const camera=this.scene.cameras.main,base={x:camera.followOffset.x,y:camera.followOffset.y};
    this.shakeBase=base;
    const phase={step:0},offsets=this.catalog.feedback.shakeOffsets;
    const apply=()=>{const offset=offsets[Math.min(offsets.length-1,Math.floor(phase.step))];camera.setFollowOffset(base.x-offset.x,base.y-offset.y);};
    apply();
    this.shake=this.scene.tweens.add({targets:phase,step:offsets.length,duration:offsets.length*60,ease:'Linear',paused:this.paused,
      onUpdate:apply,onComplete:()=>this.cancelShake()});
  }
  vibrate(durationMs:number):void {
    if(this.visible&&this.vibrationEnabled&&typeof navigator!=='undefined')navigator.vibrate?.(durationMs);
  }
  cancelShake():void {
    this.shake?.stop();this.shake=undefined;
    if(this.shakeBase)this.scene.cameras.main?.setFollowOffset(this.shakeBase.x,this.shakeBase.y);
    this.shakeBase=undefined;
  }
  setPaused(paused:boolean):void {
    if(this.paused===paused)return;this.paused=paused;
    if(paused)this.shake?.pause();else this.shake?.resume();
    for(const effect of this.effects)for(const sprite of effect.list as Phaser.GameObjects.Sprite[])
      if(paused)sprite.anims.pause();else sprite.anims.resume();
  }
  setVisible(visible:boolean):void {
    this.visible=visible;if(!visible)this.cancelShake();
    for(const effect of this.effects)effect.setVisible(visible);
  }
  destroy():void {this.cancelShake();for(const effect of [...this.effects])effect.destroy();}
}
