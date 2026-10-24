import Phaser from 'phaser';
import {LOGIC_FRAME_MS} from '../domain/battle.ts';
import type {AttackPlacement,BattleCatalog,SkillVisualEffect,SkillEffectCue} from '../domain/battle.ts';
import type {ActionPlayback,Combatant,SkillUnitHit} from '../domain/combat.ts';
import type {SkillUnitOutcome} from '../domain/skill-unit-sequence.ts';
import type {FlightEvent} from '../domain/combat-runtime.ts';
import {skillRepeatSkippedFrames,skillSequence} from '../domain/skill-action.ts';
import {attackSequence} from '../domain/basic-attack.ts';
import {attackCycleFrames} from '../domain/combat-tempo.ts';
import type {ClipName} from '../domain/content.ts';
import type {Point} from '../domain/navigation.ts';
import {isCurrentLayers,playCharacterSequence,setCharacterClip,showIdlePose,type CharacterVisual} from './characters.ts';
import {createEffect,setEffectClip} from './effects.ts';
import {CombatEffects} from './combat-effects.ts';
export type {ActionDispatchRunner} from '../domain/combat-action-dispatcher.ts';
export { basicAttackEffects, classEffects } from './combat-asset-descriptors.ts';

/** Phaser 动作表现适配器。实体身份由场景解析，规则不保存 Sprite 或 DOM。 */
export class CombatPresenter {
  readonly effects = new Set<Phaser.GameObjects.Container>();
  private readonly buffEffects = new Set<Phaser.GameObjects.Container>();
  private readonly scene: Phaser.Scene;
  private readonly catalog: BattleCatalog;
  private readonly visual: (id: string) => CharacterVisual | undefined;
  private readonly candidates: () => Combatant[];
  private readonly flights=new Map<number,{visual:Phaser.GameObjects.Container;effect:string;directional:boolean}>();
  private readonly combatEffects:CombatEffects;
  private readonly ownsCombatEffects:boolean;
  private screenTint?: Phaser.GameObjects.Rectangle;
  private transitionEffects?: Phaser.GameObjects.Layer;
  private afterimages?: Phaser.GameObjects.Container;
  constructor(scene:Phaser.Scene,catalog:BattleCatalog,visual:(id:string)=>CharacterVisual|undefined,candidates:()=>Combatant[],combatEffects?:CombatEffects){
    this.scene=scene;this.catalog=catalog;this.visual=visual;this.candidates=candidates;
    this.combatEffects=combatEffects??new CombatEffects(scene);this.ownsCombatEffects=combatEffects===undefined;
  }
  play(action:ActionPlayback):()=>void {
    const character=this.visual(action.caster.id)!;
    // 待机等待动作不改画面，只把起手时的图层收起来，收尾再放出来。
    const hidden=action.basicAttackWait?character.layers.map(layer=>({layer,visible:layer.visible})):[];
    if(action.basicAttackWait)for(const {layer} of hidden)layer.setVisible(false);
    else{
      const name=action.skill?(action.skill.clips?.[action.facing]??`skill-${action.skill.id}-${action.facing}` as ClipName):action.basicAttack!.clips[action.facing];
      const clip=character.actor.clips[name]!;
      const attack=action.skill?undefined:action.basicAttack!;
      const sequence=attack?attack.timing==='fixed-animation'?attack.sequence[action.facing]:attackSequence(clip.frames,attackCycleFrames(attack.cycleFrames,0,attack.strikeFrame)):
        action.skill?.action.repeat?skillSequence(action.skill.action,action.skill.level??1,clip.frames):undefined;
      if(sequence)playCharacterSequence(this.scene,character,name,sequence,attack?.frameDurationMs??LOGIC_FRAME_MS);
      else setCharacterClip(this.scene,character,name,true);
    }
    const layers=character.layers;
    return ()=>{
      this.clearPose();this.screenTint?.setVisible(false);
      // 动作还没收尾，画面就被换掉过（剧情投影、换装、别的动作接手）：起手时那批 Sprite 已销毁，
      // 收尾只能放手——放它们会读到 undefined 的 anims 并把异常抛进主循环，停新图层的动画则会打断接手者。
      if(!isCurrentLayers(character,layers))return;
      for(const {layer,visible} of hidden)layer.setVisible(visible);
      for(const layer of layers)layer.anims.stop();
    };
  }
  projectFrame(action:ActionPlayback,index:number):void {
    this.pose(action,index);this.syncActionAnimation(action,index);
  }
  syncActionAnimation(action:ActionPlayback,index:number):void {
    const character=this.visual(action.caster.id);if(!character)return;
    if(action.basicAttack&&!action.skill){const clip=character.actor.clips[action.basicAttack.clips[action.facing]]!;showIdlePose(character,action.facing,index,clip.frames);}
    if(action.skill?.action.repeat){
      const name=action.skill.clips?.[action.facing]??`skill-${action.skill.id}-${action.facing}` as ClipName;
      const clip=character.actor.clips[name];
      if(clip){
        const sequence=skillSequence(action.skill.action,action.skill.level??1,clip.frames);
        if(action.skill.action.repeat.facesTargetOnRelease)this.faceRepeatingAction(character,action,sequence,LOGIC_FRAME_MS);
        const skip=skillRepeatSkippedFrames(action.skill.action,action.skill.level??1,action.repeatState);
        if(skip)for(const layer of character.layers){const animation=layer.anims.currentAnim;if(animation)layer.anims.setCurrentFrame(animation.frames[Math.min(index+skip,animation.frames.length-1)]);}
      }
    }
  }
  renderEffect(name:string,variant:string,position:Point,placement?:AttackPlacement,recipientId?:string):void {
    const character=recipientId?this.visual(recipientId):undefined;
    if(placement&&character?.container.active)this.placedEffect(name,variant,position,placement,character);
    else if(!placement)this.effect(name,variant,position);
  }
  renderFlight(event:FlightEvent):void {
    if(event.kind==='start'){
      const visual=this.effect(event.effect,event.directional?`heading-${event.heading}`:'default',event.position,true);
      this.flights.set(event.id,{visual,effect:event.effect,directional:event.directional});
      if(event.aboveCharacters){this.transitionEffects??=this.scene.add.layer().setDepth(Number.MAX_SAFE_INTEGER-1);this.transitionEffects.add(visual);}
    }else{
      const flight=this.flights.get(event.id);if(!flight)return;
      if(event.kind==='end'){flight.visual.destroy();this.flights.delete(event.id);return;}
      this.scene.tweens.killTweensOf(flight.visual);
      if(flight.directional)setEffectClip(this.scene,flight.visual,this.catalog.attackEffects[flight.effect].clips[`heading-${event.heading}`],true);
      this.scene.tweens.add({targets:flight.visual,x:event.position.x,y:event.position.y,duration:event.durationMs,onUpdate:()=>flight.visual.setDepth(flight.visual.y+1)});
    }
  }
  setPaused(paused:boolean):void {
    for(const effect of [...this.effects,...this.buffEffects]){
      for(const layer of effect.list as Phaser.GameObjects.Sprite[])if(paused)layer.anims.pause();else layer.anims.resume();
      for(const tween of this.scene.tweens.getTweensOf(effect))if(paused)tween.pause();else tween.resume();
    }
  }
  private faceRepeatingAction(character:CharacterVisual,action:ActionPlayback,sequence:number[],frameDurationMs:number):void{
    const name=action.skill!.clips?.[action.facing]??`skill-${action.skill!.id}-${action.facing}` as ClipName;
    if(character.clipName===name)return;
    const clip=character.actor.clips[name]!;
    const flipped=!!clip.mirrorX!==!!character.entity.flip;
    for(const [index,sprite]of character.layers.entries()){
      const source=clip.layers[index];if(!source)continue;
      const key=`${source.key}#action`;
      if(!sprite.anims.exists(key))sprite.anims.create({key,frames:sequence.map(frame=>({key:source.key,frame})),
        frameRate:1000/frameDurationMs,repeat:0});
      // 各图层由 Phaser 依次更新，保留各自进度，避免后更新的武器层多走一帧。
      const startFrame=Math.max(0,(sprite.anims.currentFrame?.index??1)-1);
      const elapsed=sprite.anims.accumulator,nextTick=sprite.anims.nextTick;
      sprite.play({key,startFrame});
      sprite.anims.accumulator=elapsed;sprite.anims.nextTick=nextTick;
      sprite.setOrigin(clip.originX,clip.originY).setScale(flipped?-1:1,1);
    }
    character.clipName=name;character.flipped=flipped;
  }
  screenFill(fillTransparency:number):void{
    if(fillTransparency>=100){this.screenTint?.setVisible(false);return;}
    const camera=this.scene.cameras.main;
    this.screenTint??=this.scene.add.rectangle(0,0,camera.width,camera.height,0xffffff)
      .setOrigin(0,0).setScrollFactor(0).setDepth(Number.MAX_SAFE_INTEGER-2).setName('skill-screen-fill');
    // 视口会随窗口变化，每次按当前可见范围摆一次，避免拉伸出屏幕外。
    this.screenTint.setSize(camera.width,camera.height).setVisible(true).setAlpha((100-fillTransparency)/100);
  }
  private pose(playback:ActionPlayback,index:number):void{
    this.clearPose();
    const {skill,facing}=playback,character=this.visual(playback.caster.id);
    if(!skill||!character)return;
    const direction={x:facing==='east'?1:facing==='west'?-1:0,y:facing==='south'?1:facing==='north'?-1:0};
    const trail=skill.action.afterimages;
    if(trail?.frame!==index)return;
    const container=this.scene.add.container(0,0).setName('action-afterimages');
    this.afterimages=container;
    // South-facing copies draw in front of the body; the other facings draw behind it.
    character.container.addAt(container,facing==='south'?character.layers.length:0);
    const distances=facing==='south'?[...trail.distancesPx].reverse():trail.distancesPx;
    for(const distance of distances)for(const sprite of character.layers){
      const frames=sprite.anims.currentAnim?.frames;
      const frame=frames?.[Math.min(index,frames.length-1)];
      if(!frame)continue;
      container.add(this.scene.add.image(direction.x*distance,direction.y*distance,frame.textureKey,frame.textureFrame)
        .setOrigin(sprite.originX,sprite.originY).setScale(sprite.scaleX,sprite.scaleY)
        .setBlendMode(sprite.blendMode).setAlpha(trail.opacity));
    }
  }
  private clearPose():void{
    this.afterimages?.destroy();this.afterimages=undefined;
  }
  private visualEffect(visual:SkillVisualEffect,variant:string,actor:Combatant):void{
    const character=this.visual(actor.id);
    if(!character?.container.active)return;
    this.placedEffect(visual.effect,variant,actor.position,visual.placement,character);
    this.scene.events.emit('skill-effect',{name:visual.effect,variant,recipientId:actor.id,placement:visual.placement});
  }
  showEffects(id:string,effects:SkillVisualEffect[]):void{
    const actor=this.candidates().find(candidate=>candidate.id===id);
    if(actor)for(const visual of effects)this.visualEffect(visual,'default',actor);
  }
  /** Unit feedback follows its resolved outcome, before the next unit executes. */
  showUnitFeedback(hit:SkillUnitHit,outcome:SkillUnitOutcome,cue:SkillEffectCue):void {
    if(outcome==='skipped'||outcome==='failure'&&cue.unitFeedbackPolicy!=='always')return;
    const candidates=this.candidates();
    for(const visual of cue.effects){
      const id=visual.recipient==='caster'?hit.casterId:hit.targetId;
      const actor=candidates.find(candidate=>candidate.id===id);
      if(actor)this.visualEffect(visual,'default',actor);
    }
  }
  /** 增益应用动画附着受术者，独立于当前攻击；多次成功刷新可以重叠播放。 */
  showBuffApplication(id:string,name:string,followTarget=true):void {
    const character=this.visual(id);if(!character?.container.active)return;
    const clip=this.catalog.attackEffects[name]?.clips.default;
    if(!clip)throw new Error(`增益特效资源缺失：${name}`);
    const effect=createEffect(this.scene,clip,followTarget?0:character.container.x,followTarget?0:character.container.y).setName(name);
    this.buffEffects.add(effect);effect.once('destroy',()=>this.buffEffects.delete(effect));
    if(followTarget)character.container.addAt(effect,character.layers.length);
    else effect.setDepth(Number.MAX_SAFE_INTEGER);
  }
  private placedEffect(name:string,variant:string,worldPosition:Point,placement:AttackPlacement,character:CharacterVisual):void{
    const definition=this.catalog.attackEffects[name];
    const position=placement==='attached'
      ?definition.attachmentPoint==='feet'?{x:0,y:0}:character.actor.effectAnchor
      :worldPosition;
    if(!position)throw new Error(`人物缺少特效锚点：${character.actor.id}`);
    const effect=this.effect(name,variant,position);
    const textureKeys=definition.clips[variant].layers.map(layer=>layer.key);
    if(placement==='attached'){
      if(definition.attachedLifetime==='character'){
        this.effects.delete(effect);
        this.combatEffects.addToCharacter(effect,character,textureKeys);
      }else character.container.addAt(effect,character.layers.length);
    }else{
      this.effects.delete(effect);
      this.combatEffects.addWorld(effect,placement,textureKeys);
    }
  }
  private effect(name:string,variant:string,position:Point,loop=false):Phaser.GameObjects.Container{
    const clip=this.catalog.attackEffects[name]?.clips[variant];
    if(!clip)throw new Error(`特效资源缺失：${name}/${variant}`);
    const effect=createEffect(this.scene,clip,position.x,position.y,loop).setName(name);this.effects.add(effect);
    effect.once('destroy',()=>{this.scene.tweens.killTweensOf(effect);this.effects.delete(effect);});return effect;
  }
  clear():void{
    this.clearPose();
    this.screenTint?.destroy();this.screenTint=undefined;
    this.flights.clear();
    for(const effect of [...this.effects])effect.destroy();
    if(this.ownsCombatEffects)this.combatEffects.clear();
    this.transitionEffects?.destroy();this.transitionEffects=undefined;
  }
  reset():void{this.clear();for(const effect of [...this.buffEffects])effect.destroy();}
}
