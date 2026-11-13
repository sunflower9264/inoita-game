import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks, createRequire } from 'node:module';
import {readFileSync} from 'node:fs';
import {PNG} from 'pngjs';
import type Phaser from 'phaser';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { statusColorMatrix } from '../src/domain/status-color.ts';

const require=createRequire(import.meta.url);
const BlendModes=require('../node_modules/phaser/src/renderer/BlendModes.js');
const TintModes=require('../node_modules/phaser/src/renderer/TintModes.js');
const TINT_FILL=TintModes.FILL;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default '+JSON.stringify({Core:{Events:{POST_RENDER:'postrender'}},BlendModes,TintModes}),shortCircuit:true}
  :next(specifier,context);}});
const {StatusColorRenderer}=await import('../src/rendering/status-color.ts');hook.deregister();

type Filter={active:boolean;matrix:number[];colorMatrix:{set(value:number[]):void};setActive(value:boolean):void};
type Sprite={blendMode:number;active:boolean;isTinted:boolean;tintMode:number;tintTopLeft:number;
  setTint(color:number):Sprite;setTintMode(mode:number):Sprite;clearTint():Sprite;
  filters:{internal:{addColorMatrix():Filter}};enableFilters():void};

function fixture(){
  const events=new EventEmitter(),scene={game:{events}} as unknown as Phaser.Scene;
  const filter:Filter={active:false,matrix:[],colorMatrix:{set(value:number[]){filter.matrix=[...value];}},setActive(value:boolean){filter.active=value;}};
  const sprite:Sprite={blendMode:0,active:true,isTinted:false,tintMode:0,tintTopLeft:0xffffff,
    setTint(color:number){sprite.isTinted=true;sprite.tintTopLeft=color;return sprite;},
    setTintMode(mode:number){sprite.tintMode=mode;return sprite;},
    clearTint(){sprite.isTinted=false;sprite.tintTopLeft=0xffffff;return sprite;},
    filters:{internal:{addColorMatrix:()=>filter}},enableFilters(){}};
  const character={container:{active:true},layers:[sprite]} as unknown as CharacterVisual;
  return {renderer:new StatusColorRenderer(),scene,events,character,sprite,filter};
}

test('hit flash tints the sprite white without filters and restores it after rendering',()=>{
  const f=fixture();
  f.renderer.flash(f.character,f.scene);
  f.renderer.flash(f.character,f.scene);
  // 同一帧内重复触发只挂一个渲染后回调，避免恢复两次。
  assert.equal(f.events.listenerCount('postrender'),1);
  assert.equal(f.sprite.isTinted,true);
  assert.equal(f.sprite.tintTopLeft,0xffffff);
  assert.equal(f.sprite.tintMode,TINT_FILL);
  // 闪白不再为角色开滤镜。
  assert.equal(f.filter.active,false);
  f.events.emit('postrender');
  assert.equal(f.sprite.isTinted,false);
  assert.equal(f.sprite.tintMode,0);
  assert.equal(f.filter.active,false);
  f.renderer.flash(f.character,f.scene);
  assert.equal(f.sprite.isTinted,true);
  f.events.emit('postrender');
  assert.equal(f.sprite.isTinted,false);
});

test('hit flash restores a tint that was already on the sprite',()=>{
  const f=fixture();
  f.sprite.setTint(0x336699).setTintMode(1);
  f.renderer.flash(f.character,f.scene);
  assert.equal(f.sprite.tintTopLeft,0xffffff);
  assert.equal(f.sprite.tintMode,TINT_FILL);
  f.events.emit('postrender');
  assert.equal(f.sprite.isTinted,true);
  assert.equal(f.sprite.tintTopLeft,0x336699);
  assert.equal(f.sprite.tintMode,1);
});

test('status color matrix keeps following the latest frame during a flash',()=>{
  const f=fixture(),colors=[{red:100,green:0,blue:0},{red:0,green:60,blue:0}];
  f.renderer.paint(f.character,colors,0);
  f.renderer.flash(f.character,f.scene);
  f.renderer.paint(f.character,colors,1);
  assert.equal(f.filter.active,true);
  assert.deepEqual(f.filter.matrix,statusColorMatrix(colors,1));
  f.events.emit('postrender');
  assert.equal(f.filter.active,true);
  assert.deepEqual(f.filter.matrix,statusColorMatrix(colors,1));
  assert.equal(f.sprite.isTinted,false);
});


test('opaque black-backed ghost layers brighten without filling their rectangles',()=>{
  for(const [file,blend] of [['enemy-ghost-1/attack-east-add.png',BlendModes.ADD],['enemy-ghost-2/attack-east-screen.png',BlendModes.SCREEN]] as const){
    const png=PNG.sync.read(readFileSync(new URL('../asset-source/assets/characters/'+file,import.meta.url)));
    assert.deepEqual([...png.data.subarray(0,4)],[0,0,0,255]);
    const f=fixture();f.sprite.blendMode=blend;
    f.sprite.enableFilters=()=>{throw new Error('flash must stay on the vertex tint path');};
    f.renderer.flash(f.character,f.scene);
    assert.equal(f.sprite.tintMode,TintModes.OVERLAY,file);
    assert.equal(f.sprite.tintTopLeft,0xffffff);
    f.events.emit('postrender');assert.equal(f.sprite.isTinted,false);assert.equal(f.sprite.blendMode,blend);
  }
});

test('reused layers choose the new blend mode while restoring the original tint',()=>{
  const f=fixture();f.sprite.setTint(0x336699).setTintMode(TintModes.MULTIPLY);
  f.renderer.flash(f.character,f.scene);assert.equal(f.sprite.tintMode,TintModes.FILL);
  f.sprite.blendMode=BlendModes.ADD;f.character.layers=[...f.character.layers];
  f.renderer.paint(f.character,undefined,0);assert.equal(f.sprite.tintMode,TintModes.OVERLAY);
  f.sprite.blendMode=BlendModes.NORMAL;f.character.layers=[...f.character.layers];
  f.renderer.paint(f.character,undefined,0);assert.equal(f.sprite.tintMode,TintModes.FILL);
  f.events.emit('postrender');assert.equal(f.sprite.tintTopLeft,0x336699);assert.equal(f.sprite.tintMode,TintModes.MULTIPLY);
});

test('flash restores both replaced layers and newly attached glowing layers',()=>{
  const f=fixture(),next=fixture().sprite;next.blendMode=BlendModes.SCREEN;
  f.renderer.flash(f.character,f.scene);
  f.character.layers=[next as unknown as Phaser.GameObjects.Sprite];
  f.renderer.paint(f.character,undefined,0);assert.equal(next.tintMode,TintModes.OVERLAY);
  f.events.emit('postrender');assert.equal(f.sprite.isTinted,false);assert.equal(next.isTinted,false);
});
