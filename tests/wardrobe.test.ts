import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type Phaser from 'phaser';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { Wardrobe } from '../src/rendering/wardrobe.ts';

class PreviewImage {
  src='preview';
  decode():Promise<void>{return Promise.resolve();}
}

function setup(t:test.TestContext){
  const original=Object.getOwnPropertyDescriptor(globalThis,'HTMLImageElement');
  Object.defineProperty(globalThis,'HTMLImageElement',{value:PreviewImage,configurable:true});
  t.after(()=>{
    if(original)Object.defineProperty(globalThis,'HTMLImageElement',original);
    else Reflect.deleteProperty(globalThis,'HTMLImageElement');
  });
  const events=new EventEmitter(),renderer=new EventEmitter(),textures=new Set<string>(),snapshots:((image:PreviewImage)=>void)[]=[];
  const ops=new Map<string,{stamps:number;clears:number;renders:number}>();
  const scene={events,game:{renderer},anims:{exists:()=>false},textures:{
    addDynamicTexture(key:string){
      textures.add(key);
      const op={stamps:0,clears:0,renders:0};ops.set(key,op);
      return {clear(){op.clears++;},stamp(){op.stamps++;},add(){},render(){op.renders++;},snapshotArea(_x:number,_y:number,_w:number,_h:number,callback:(image:PreviewImage)=>void){snapshots.push(callback);}};
    },
    exists:(key:string)=>textures.has(key),remove:(key:string)=>textures.delete(key)
  }} as unknown as Phaser.Scene;
  const catalog:WardrobeCatalog={textures:[],sprites:{},defaults:{},variants:{},equipment:{},
    stances:{'unarmed:empty':{'idle-south':'idle'}},skills:{},skillStances:{},attacks:{},
    poses:{idle:{frames:[[]],frameRate:10,mirrorX:false}}};
  const wardrobe=new Wardrobe(scene,catalog,{items:{}} as ItemCatalog);
  const actor={id:'hero',clips:{}} as ActorDefinition;
  return {wardrobe,textures,events,renderer,ops,snapshots,prepare:()=>wardrobe.prepare(actor,{},'hero'),finish:(index:number)=>snapshots[index](new PreviewImage())};
}

test('concurrent outfit requests share their generated textures and release all of them',async t=>{
  const run=setup(t),first=run.prepare(),second=run.prepare();
  assert.equal(run.snapshots.length,1);
  run.finish(0);
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);assert.equal(run.textures.size,1);
  assert.equal(await run.prepare(),a);
  run.wardrobe.clear();assert.equal(run.textures.size,0);
});

test('restoring the WebGL context repaints cached outfit textures in place',async t=>{
  const run=setup(t),pending=run.prepare();
  run.finish(0);const outfit=await pending;run.wardrobe.activate(outfit);
  for(const key of outfit.textures){const op=run.ops.get(key)!;assert.equal(op.clears,1);assert.equal(op.renders,1);}
  run.renderer.emit('restorewebgl');
  for(const key of outfit.textures){const op=run.ops.get(key)!;assert.equal(op.clears,2,'恢复后先清空旧的显存内容');assert.equal(op.renders,2,'恢复后重新画进原纹理键');}
  // 动画帧和纹理键不换，场景里已有的角色和动画继续引用同一份外观。
  assert.deepEqual([...run.textures],[...outfit.textures]);
  run.wardrobe.destroy();
  run.renderer.emit('restorewebgl');
  assert.equal(run.ops.get(outfit.textures[0]!)!.renders,2,'销毁后不再响应恢复事件');
});

test('clearing pending work rejects its result without removing a replacement request',async t=>{
  const run=setup(t),old=run.prepare(),rejected=assert.rejects(old,{name:'AbortError'});
  run.wardrobe.clear();
  const replacement=run.prepare();
  await rejected;
  const shared=run.prepare();
  assert.equal(run.snapshots.length,2);
  run.finish(0);
  run.finish(1);
  assert.equal(await replacement,await shared);
  assert.equal(run.textures.size,1);
  run.wardrobe.clear();assert.equal(run.textures.size,0);
});

test('scene shutdown disposes a pending outfit and rejects further preparation',async t=>{
  const run=setup(t),pending=run.prepare(),rejected=assert.rejects(pending,{name:'AbortError'});
  run.events.emit('shutdown');await rejected;
  assert.equal(run.textures.size,0);
  run.finish(0);assert.equal(run.textures.size,0);
  await assert.rejects(run.prepare(),{name:'AbortError'});
  assert.equal(run.snapshots.length,1);
});

test('explicit outfit disposal cancels pending texture work and removes its scene listener',async t=>{
  const run=setup(t),pending=run.prepare(),rejected=assert.rejects(pending,{name:'AbortError'});
  assert.equal(run.events.listenerCount('shutdown'),1);
  run.wardrobe.destroy();await rejected;
  assert.equal(run.events.listenerCount('shutdown'),0);
  assert.equal(run.textures.size,0);
  run.finish(0);assert.equal(run.textures.size,0);
  run.wardrobe.destroy();await assert.rejects(run.prepare(),{name:'AbortError'});
});
