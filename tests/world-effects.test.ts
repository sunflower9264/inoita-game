import {dispatchFrame,playCombat} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {ActorDefinition,AnimationClip,EffectClip,EffectLayer} from '../src/domain/content.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatPort} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {loadSceneAssets,type PendingAsset} from '../src/rendering/scene-assets.ts';
import {EFFECT_ATLAS_BY_FILE,EFFECT_ATLAS_PAGES} from '../src/generated/effect-atlas.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');
const {CombatEffects}=await import('../src/rendering/combat-effects.ts');
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {createEffect,effectAssets,effectAtlasAnimationKey}=await import('../src/rendering/effects.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const effectLayers=(name:string,clipNames?:readonly string[])=>Object.entries(catalog.attackEffects[name]!.clips)
  .filter(([clipName])=>!clipNames||clipNames.includes(clipName))
  .flatMap(([,clip])=>clip.layers.map(layer=>({clip,layer})));
/** 一个特效实际持有的纹理键：图集化后是页 key，未映射的旧层才用图层 key。 */
const effectTextureKeys=(name:string,clipNames?:readonly string[]):string[]=>[...new Set(effectLayers(name,clipNames).flatMap(({clip,layer})=>{
  const refs=EFFECT_ATLAS_BY_FILE[layer.file];
  return refs?.length?refs.slice(0,clip.frames).map(ref=>EFFECT_ATLAS_PAGES[ref.page]!.key):[layer.key];
}))];
/** 图集层的动画键跟 effects.ts 一致：文件、页和帧参数共同确定身份。 */
const atlasAnimationKey=(layer:EffectLayer,clip:EffectClip):string=>{
  const refs=EFFECT_ATLAS_BY_FILE[layer.file];
  if(!refs?.length)return layer.key;
  const pages=[...new Set(refs.slice(0,clip.frames).map(ref=>EFFECT_ATLAS_PAGES[ref.page]!.key))];
  return effectAtlasAnimationKey(layer,clip,pages);
};
/** 一个特效实际创建的动画键：图集层带文件与帧参数，未映射的旧层用图层 key。 */
const effectAnimationKeys=(name:string,clipNames?:readonly string[]):string[]=>[...new Set(effectLayers(name,clipNames).map(({clip,layer})=>atlasAnimationKey(layer,clip)))];

interface Animation {key:string;frames:unknown[];frameRate:number;repeat?:number}
class Display extends EventEmitter {
  active=true;visible=true;alpha=1;name='';x=0;y=0;depth=0;age=0;playing=false;
  list:Display[]=[];parent?:Display;animation?:Animation;
  anims={accumulator:0,timeScale:1,stop:()=>{this.playing=false;}};
  get length(){return this.list.length;}
  setName(value:string){this.name=value;return this;}
  setDepth(value:number){this.depth=value;return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  setAlpha(value:number){this.alpha=value;return this;}
  setOrigin(){return this;}setScale(){return this;}setBlendMode(){return this;}
  add(value:Display){value.parent?.remove(value);this.list.push(value);value.parent=this;return this;}
  addAt(value:Display){return this.add(value);}
  remove(value:Display){this.list=this.list.filter(child=>child!==value);value.parent=undefined;}
  removeAll(destroy=false){for(const child of [...this.list]){this.remove(child);if(destroy)child.destroy();}}
  destroy(){if(!this.active)return;this.active=false;this.parent?.remove(this);this.emit('destroy');this.removeAll(true);this.removeAllListeners();}
}

function setup(){
  const nodes:Display[]=[],animations=new Map<string,Animation>(),textures=new Map<string,Set<number>>(),removed:string[]=[],queued:PendingAsset[]=[];
  // 战斗视觉资源是会话常驻包：夹具按真实内容预置全部特效图集页。
  for(const page of EFFECT_ATLAS_PAGES)textures.set(page.key,new Set<number>());
  const make=(x=0,y=0)=>{const value=new Display();value.x=x;value.y=y;nodes.push(value);return value;};
  const load=Object.assign(new EventEmitter(),{
    spritesheet:(key:string,file:string,config:Phaser.Types.Loader.FileTypes.ImageFrameConfig)=>queued.push({kind:'spritesheet',key,file,config}),
    image:(key:string,file:string)=>queued.push({kind:'image',key,file}),
    atlas:(key:string,file:string,atlas:string)=>queued.push({kind:'atlas',key,file,atlas}),
    start:()=>queueMicrotask(()=>{for(const asset of queued.splice(0))textures.set(asset.key,asset.kind==='atlas'?new Set():new Set(Array.from({length:asset.kind==='spritesheet'?Number(asset.config.endFrame)+1:1},(_,i)=>i)));load.emit('complete');}),
  });
  const scene={events:new EventEmitter(),load,
    textures:{exists:(key:string)=>textures.has(key),get:(key:string)=>({has:(frame:string)=>typeof frame==='string'&&!/^\d+$/.test(frame)?true:textures.get(key)!.has(Number(frame))}),remove:(key:string)=>{removed.push(key);textures.delete(key);}},
    anims:{exists:(key:string)=>animations.has(key),get:(key:string)=>animations.get(key),
      create:(value:Animation)=>{animations.set(value.key,value);return value;},
      generateFrameNumbers:(_key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>i+start),
      remove:(key:string)=>animations.delete(key)},
    add:{container:make,layer:()=>make(),sprite:()=>Object.assign(make(),{
      play(this:Display,config:{key:string}){this.animation=animations.get(config.key);this.age=0;this.playing=true;return this;},
    })},
    tweens:{killTweensOf:()=>{},add:()=>({remove:()=>{}})},time:{delayedCall:()=>({remove:()=>{}})},facing:'east',
  } as unknown as Phaser.Scene;
  const advance=(count:number)=>{for(let tick=0;tick<count;tick++)for(const node of [...nodes]){
    if(!node.active||!node.playing||!node.animation)continue;
    if(++node.age>=node.animation.frames.length){node.playing=false;node.emit('animationcomplete');}
    else node.emit('animationupdate',node.animation,{index:node.age+1});
  }};
  const character=(id:string)=>({entity:{id,actor:id,x:0,y:0},actor:{id,effectAnchor:{x:0,y:-8},clips:{}},container:make(),layers:[],clipName:null}) as unknown as CharacterVisual;
  const actor=(id:string):Combatant=>({id,team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const effects=(name:string)=>nodes.filter(node=>node.name===name&&node.active);
  return {scene,nodes,animations,textures,removed,character,actor,effects,advance};
}

test('shared world visuals survive real member death and controller clears while attached and transition visuals are cancelled',()=>{
  const f=setup(),world=new CombatEffects(f.scene),ids=['player','ally','enemy'];
  const visuals=new Map(ids.map(id=>[id,f.character(id)])),actors=ids.map(f.actor);
  const presenters=new Map(ids.map(id=>[id,new CombatPresenter(f.scene,catalog,key=>visuals.get(key),()=>actors,world)]));
  const controllers=new Map(ids.map(id=>{
    const presenter=presenters.get(id)!;
    const port={cooldowns:new CombatCooldownStore(()=>0).forActor(id),actor:()=>actors.find(value=>value.id===id),candidates:()=>actors,
      facing:()=> 'east',moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>presenter.clear(),play:()=>()=>{},frame:()=>{}} as CombatPort;
    return [id,new CombatController(id,null,port)];
  }));
  for(const id of ids){
    const presenter=presenters.get(id)!,caster=f.actor(id);
    dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'swirling-storm',action:catalog.skills['swirling-storm'].action!,level:1}},0);
    dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'weapon-hitback',action:catalog.skills['weapon-hitback'].action!,level:1}},2);
    presenter.showEffects(id,[{effect:'life-drain',recipient:'caster',placement:'attached'}]);
    // In-flight visuals remain owned by the presenter, unlike already-created field effects.
    Reflect.get(CombatPresenter.prototype,'effect').call(presenter,'hitback-wave','default',{x:0,y:0},true);
  }
  assert.equal(f.effects('swirl-ring').length,3);assert.equal(f.effects('hitback-wave').length,9);
  const member={player:{health:0},clearCombatResourceLimits:()=>{}};
  const host=Object.setPrototypeOf({fallen:new Set<string>(),activeParty:ids,visualOf:(id:string)=>visuals.get(id),
    memberOf:()=>member,partyControllers:controllers,conditions:new CombatConditions(),hero:member,
    app:{session:{party:{onDefeat:()=>false}}},syncControlled:()=>{},
    allies:[{id:'ally',visual:visuals.get('ally')!,facing:'east',ai:{disable:()=>{}}}],arena:[],deathTweens:new Map(),scene:f.scene,
    movement:{position:()=>({x:0,y:0}),stop:()=>{},setEnabled:()=>{}},
  },WorldCombat.prototype);
  Reflect.get(WorldCombat.prototype,'memberDefeated').call(host,'player');
  Reflect.get(WorldCombat.prototype,'memberDefeated').call(host,'ally');
  controllers.get('enemy')!.cancel(true);visuals.get('enemy')!.container.destroy();
  assert.equal(f.effects('life-drain').length,0);
  assert.equal(f.effects('hitback-wave').length,6);assert.equal(f.effects('swirl-ring').length,3);
  f.advance(5);assert.equal(f.effects('hitback-wave').length,0);assert.equal(f.effects('swirl-ring').length,3);
  world.clear();world.clear();assert.equal(f.effects('swirl-ring').length,0);
});

test('the 24-frame actor playback completes while its independent 26-frame world ring keeps playing',()=>{
  const f=setup(),world=new CombatEffects(f.scene),visual=f.character('player'),caster=f.actor('player');
  const clip={frameWidth:8,frameHeight:8,frames:24,frameRate:1000/60,originX:.5,originY:1,layers:[{key:'actor-spin',file:'',blend:'normal'}]} as AnimationClip;
  visual.actor={...visual.actor,clips:{'skill-swirling-storm-east':clip}} as ActorDefinition;
  const presenter=new CombatPresenter(f.scene,catalog,()=>visual,()=>[caster],world);
  const playback:ActionPlayback={caster,facing:'east',basicAttack:null,skill:{id:'swirling-storm',action:catalog.skills['swirling-storm'].action!,level:1}};
  const frames:number[]=[],complete: number[]=[];
  playCombat(presenter,playback,index=>frames.push(index),()=>complete.push(24));dispatchFrame(presenter,playback,0);
  f.advance(23);assert.deepEqual(complete,[]);assert.equal(f.effects('swirl-ring').length,1);
  f.advance(1);assert.deepEqual(complete,[24]);assert.equal(frames.at(-1),23);assert.equal(f.effects('swirl-ring').length,1);
  presenter.clear();assert.equal(f.effects('swirl-ring').length,1);
  f.advance(1);assert.equal(f.effects('swirl-ring').length,1);
  f.advance(1);assert.equal(f.effects('swirl-ring').length,0);world.clear();
});

test('world effects retain actual scene asset leases until their own animation finishes or the world is cleared',async()=>{
  const f=setup(),world=new CombatEffects(f.scene),visual=f.character('player'),caster=f.actor('player');
  const assets=effectAssets({'swirl-ring':catalog.attackEffects['swirl-ring'],'hitback-wave':catalog.attackEffects['hitback-wave']});
  const actorLease=await loadSceneAssets(f.scene,assets,()=>{});
  const presenter=new CombatPresenter(f.scene,catalog,()=>visual,()=>[caster],world);
  dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'swirling-storm',action:catalog.skills['swirling-storm'].action!,level:1}},0);
  dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'weapon-hitback',action:catalog.skills['weapon-hitback'].action!,level:1}},2);
  const variants=['east','default'] as const;
  const ringTextures=effectTextureKeys('swirl-ring');
  const waveTextures=effectTextureKeys('hitback-wave',variants);
  const ringAnimations=effectAnimationKeys('swirl-ring');
  const waveAnimations=effectAnimationKeys('hitback-wave',variants);
  presenter.clear();actorLease.release();
  for(const key of [...ringTextures,...waveTextures])assert.equal(f.textures.has(key),true,key);
  for(const key of [...ringAnimations,...waveAnimations])assert.equal(f.animations.has(key),true,key);
  f.advance(5);
  for(const key of waveTextures)assert.equal(f.textures.has(key),false,key);
  for(const key of waveAnimations)assert.equal(f.animations.has(key),false,key);
  for(const key of ringTextures)assert.equal(f.textures.has(key),true,key);
  for(const key of ringAnimations)assert.equal(f.animations.has(key),true,key);
  world.clear();
  for(const key of ringTextures)assert.equal(f.textures.has(key),false,key);
  for(const key of ringAnimations)assert.equal(f.animations.has(key),false,key);
  assert.equal(new Set(f.removed).size,f.removed.length,'leases release each texture exactly once');
});

test('图集页释放后，另一个场景创建的特效动画会被清理并在重载后重建',async()=>{
  const f=setup();
  const effect=catalog.attackEffects['rampage-burst']!;
  const clip=effect.clips.default!;
  const assets=effectAssets({'rampage-burst':effect});
  const lease=await loadSceneAssets(f.scene,assets,()=>{});
  // 加载贴图的场景和创建特效的场景不同，但 Phaser 的 anims/textures 是全游戏共用的。
  const otherScene={...f.scene} as unknown as Phaser.Scene;
  const first=createEffect(otherScene,clip,0,0,true);
  const keys=clip.layers.filter(layer=>EFFECT_ATLAS_BY_FILE[layer.file]).map(layer=>atlasAnimationKey(layer,clip));
  assert.ok(keys.length,'用例需要至少一层图集特效');
  for(const key of keys)assert.ok(f.animations.has(key),key);
  const before=new Map(keys.map(key=>[key,f.animations.get(key)]));
  lease.release();
  for(const key of keys)assert.ok(f.animations.has(key),'持续特效仍持有图集');
  first.destroy();
  for(const key of keys)assert.equal(f.animations.has(key),false,`页释放后应删除动画：${key}`);
  const reloaded=await loadSceneAssets(f.scene,assets,()=>{});
  const second=createEffect(otherScene,clip,0,0,true);
  for(const key of keys)assert.notEqual(f.animations.get(key),before.get(key),`重载后应重建动画：${key}`);
  first.destroy();second.destroy();reloaded.release();
});

test('帧已经失效的特效动画在播放前会被重建',async()=>{
  const f=setup();
  const effect=catalog.attackEffects['rampage-burst']!;
  const clip=effect.clips.default!;
  const layer=clip.layers.find(value=>EFFECT_ATLAS_BY_FILE[value.file])!;
  const key=atlasAnimationKey(layer,clip);
  const lease=await loadSceneAssets(f.scene,effectAssets({'rampage-burst':effect}),()=>{});
  const stale={key,frames:[{frame:{texture:null}}],frameRate:1} as unknown as Animation;
  f.animations.set(key,stale);
  const container=createEffect(f.scene,clip,0,0,true);
  assert.notEqual(f.animations.get(key),stale,'失效动画应在播放前被替换');
  container.destroy();lease.release();
});

test('a turning projectile retains every heading until its flight ends',async()=>{
  const f=setup();
  const [name,effect]=Object.entries(catalog.attackEffects).find(([,effect])=>effect.clips['heading-0']&&effect.clips['heading-23'])!;
  const assets=effectAssets({[name]:effect});
  const owner=await loadSceneAssets(f.scene,assets,()=>{});
  const presenter=new CombatPresenter(f.scene,catalog,()=>undefined,()=>[]);
  presenter.renderFlight({kind:'start',id:1,effect:name,position:{x:0,y:0},heading:0,directional:true,aboveCharacters:false});
  owner.release();
  for(const asset of assets)assert.ok(f.textures.has(asset.key),'转向所需贴图仍由飞弹持有');
  presenter.renderFlight({kind:'step',id:1,position:{x:10,y:10},heading:23,durationMs:60});
  presenter.renderFlight({kind:'end',id:1});
  for(const asset of assets)assert.equal(f.textures.has(asset.key),false,'飞弹结束释放全部方向');
});

test('horizontal flight skips unchanged depth writes while vertical flight updates its order',async t=>{
  const f=setup(),name='impact-spark';
  const owner=await loadSceneAssets(f.scene,effectAssets({[name]:catalog.attackEffects[name]}),()=>{});
  let update:()=>void=()=>{};
  t.mock.method(f.scene.tweens,'add',(config:unknown)=>{
    update=(config as {onUpdate:()=>void}).onUpdate;
    return {remove(){}} as unknown as Phaser.Tweens.Tween;
  });
  const presenter=new CombatPresenter(f.scene,catalog,()=>undefined,()=>[]);
  presenter.renderFlight({kind:'start',id:1,effect:name,position:{x:0,y:4},heading:0,directional:false,aboveCharacters:false});
  const visual=f.effects(name)[0];
  const depth=t.mock.method(visual,'setDepth',(value:number)=>{visual.depth=value;return visual;});
  presenter.renderFlight({kind:'step',id:1,position:{x:20,y:4},heading:0,durationMs:60});
  for(const x of [5,10,15,20]){visual.x=x;update();}
  assert.equal(depth.mock.callCount(),0);assert.equal(visual.depth,5);
  presenter.renderFlight({kind:'step',id:1,position:{x:20,y:10},heading:0,durationMs:60});
  visual.y=7;update();assert.equal(visual.depth,8);
  update();assert.equal(depth.mock.callCount(),1);
  visual.y=10;update();assert.equal(visual.depth,11);assert.equal(depth.mock.callCount(),2);
  presenter.renderFlight({kind:'end',id:1});owner.release();
});

test('地狱火在不同画面精度下围绕主角或佣兵生成同样的完整特效',t=>{
  let randomIndex=0;
  t.mock.method(Math,'random',()=>[0,0.999999,0.1,0.9][randomIndex++%4]!);
  for(const id of ['player','companion-1']){
    let expected:{x:number;y:number}[]|undefined;
    for(const density of [1,2,3]){
      randomIndex=0;
      const f=setup(),character=f.character(id),caster=f.actor(id);
      caster.position={x:700,y:400};
      Object.assign(character.container,caster.position);
      Object.assign(f.scene,{cameras:{main:{width:960*density,height:640*density,zoomX:3*density,zoomY:3*density}}});
      const worldEffects=new CombatEffects(f.scene);
      const presenter=new CombatPresenter(f.scene,catalog,()=>character,()=>[],worldEffects);
      t.mock.method(presenter,'projectFrame',()=>{});
      const world=Object.assign(Object.create(WorldCombat.prototype),{
        scene:f.scene,app:{battleCatalog:catalog,session:{combatTick:0}},combatants:()=>[caster],combatant:()=>caster,
      }) as {dispatcherFor(presenter:InstanceType<typeof CombatPresenter>):import('../src/domain/combat-action-dispatcher.ts').CombatActionDispatcher};
      const dispatcher=world.dispatcherFor(presenter);
      const action={caster,facing:'south',skill:{id:'summon-hellfire',level:1,action:catalog.skills['summon-hellfire']!.action!}} as ActionPlayback;
      for(let frame=0;frame<15;frame++)dispatcher.frame(action,frame);
      const flames=f.effects('hellfire-burst'),positions=flames.map(({x,y})=>({x,y}));
      assert.equal(flames.length,15);
      assert.equal(randomIndex,60,'保留每帧四次随机数消耗');
      for(const flame of flames){
        assert.equal(flame.list.length,4,'火焰四层动画都实际创建');
        assert.equal(flame.parent?.depth,Number.MAX_SAFE_INTEGER,'火焰在人物上方');
        assert.ok(Math.abs(flame.x-caster.position.x)<=144);
        assert.ok(Math.abs(flame.y-caster.position.y)<=90);
      }
      if(expected)assert.deepEqual(positions,expected);else expected=positions;
      worldEffects.clear();presenter.clear();
    }
  }
});
