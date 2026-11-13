import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type Phaser from 'phaser';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { Wardrobe } from '../src/rendering/wardrobe.ts';
import { OutfitPool, OUTFIT_CACHE_LIMIT } from '../src/rendering/outfit-pool.ts';
import { retainLoadedSceneAssets } from '../src/rendering/scene-assets.ts';
import { acquireCompanionWardrobe, COMPANION_WARDROBE_LIMIT } from '../src/rendering/wardrobe-cache.ts';

test('lazy poses belong to one outfit pool and reload after its session is cleared', async t => {
  const run = setup(t);
  const pose = run.catalog.poses.idle!;
  run.catalog.poses = {};
  let loads = 0;
  const pool = new OutfitPool(run.scene, run.catalog, { items: {} } as ItemCatalog, async () => {
    loads++; return { idle: pose };
  });
  const prepare = async () => {
    const pending = pool.acquire(run.actor, {}, 'hero', undefined, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    return pending;
  };
  const first = await prepare();
  assert.equal(loads, 1); assert.deepEqual(run.catalog.poses, {});
  first.release(); pool.clear();
  const second = await prepare();
  assert.equal(loads, 2); assert.deepEqual(run.catalog.poses, {});
  second.release(); pool.destroy(); run.wardrobe.destroy();
});

test('warming poses shares pending and completed loads with outfit preparation', async t => {
  const run = setup(t);
  const pose = run.catalog.poses.idle!;
  run.catalog.poses = {};
  let loads = 0;
  let finish!: (poses: typeof run.catalog.poses) => void;
  const pool = new OutfitPool(run.scene, run.catalog, { items: {} } as ItemCatalog, () => {
    loads++;
    return new Promise(resolve => { finish = resolve; });
  });
  const warm = pool.warmPoses(['idle']);
  const pending = pool.acquire(run.actor, {}, 'hero', undefined, new AbortController().signal);
  assert.equal(loads, 1);
  finish({ idle: pose });
  const [lease] = await Promise.all([pending, warm]);
  await pool.warmPoses(['idle']);
  assert.equal(loads, 1);
  lease.release(); pool.destroy(); run.wardrobe.destroy();
});

function setup(_t:test.TestContext,extraPoses=false,skillPose=false){
  const events=new EventEmitter(),renderer=new EventEmitter(),textures=new Set<string>();
  const ops=new Map<string,{stamps:number;clears:number;renders:number}>();
  const scene={events,game:{renderer},anims:{exists:()=>false},textures:{
    addDynamicTexture(key:string){
      textures.add(key);
      const op={stamps:0,clears:0,renders:0};ops.set(key,op);
      return {clear(){op.clears++;},stamp(){op.stamps++;},add(){},render(){op.renders++;}};
    },
    get:()=>({has:()=>true}),exists:(key:string)=>textures.has(key),remove:(key:string)=>textures.delete(key)
  }} as unknown as Phaser.Scene;
  const catalog:WardrobeCatalog={textures:[],sprites:{},defaults:{},variants:{},equipment:{},
    stances:{'unarmed:empty':extraPoses?{'idle-south':'idle','attack-north':'attack'}:{'idle-south':'idle'}},
    skills:skillPose?{hero:{'skill-firestorm-south':'firestorm'}}:{},skillStances:{},attacks:{},
    poses:{idle:{frames:[[]],frameRate:10,mirrorX:false},...(extraPoses?{attack:{frames:[[]],frameRate:10,mirrorX:false}}:{}),...(skillPose?{firestorm:{frames:[[]],frameRate:10,mirrorX:false}}:{})}};
  const wardrobe=new Wardrobe(scene,catalog,{items:{charm:{kind:'ring',equipment:{}}}} as unknown as ItemCatalog);
  const actor={id:'hero',clips:{}} as ActorDefinition;
  return {wardrobe,scene,catalog,actor,textures,events,renderer,ops,
    prepare:(options?:{clipNames?:Iterable<string>;learnedSkills?:ReadonlySet<string>})=>wardrobe.prepare(actor,{},'hero',options)};
}

test('concurrent outfit requests share their generated textures and release all of them',async t=>{
  const run=setup(t),first=run.prepare(),second=run.prepare();
  assert.equal(run.ops.size,1);
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);assert.equal(run.textures.size,1);
  assert.equal(await run.prepare(),a);
  run.wardrobe.clear();assert.equal(run.textures.size,0);
});

test('restoring the WebGL context repaints cached outfit textures in place',async t=>{
  const run=setup(t),pending=run.prepare();
  const outfit=await pending;run.wardrobe.activate(outfit);
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
  assert.equal(run.ops.size,2);
  assert.equal(await replacement,await shared);
  assert.equal(run.textures.size,1);
  run.wardrobe.clear();assert.equal(run.textures.size,0);
});

test('scene shutdown disposes a pending outfit and rejects further preparation',async t=>{
  const run=setup(t),pending=run.prepare(),rejected=assert.rejects(pending,{name:'AbortError'});
  run.events.emit('shutdown');await rejected;
  assert.equal(run.textures.size,0);
  await assert.rejects(run.prepare(),{name:'AbortError'});
  assert.equal(run.ops.size,1);
});

test('explicit outfit disposal cancels pending texture work and removes its scene listener',async t=>{
  const run=setup(t),pending=run.prepare(),rejected=assert.rejects(pending,{name:'AbortError'});
  assert.equal(run.events.listenerCount('shutdown'),1);
  run.wardrobe.destroy();await rejected;
  assert.equal(run.events.listenerCount('shutdown'),0);
  assert.equal(run.textures.size,0);
  run.wardrobe.destroy();await assert.rejects(run.prepare(),{name:'AbortError'});
});

test('preview preparation composes only the requested clip',async t=>{
  const run=setup(t,true),pending=run.prepare({clipNames:['idle-south']});
  assert.equal(run.ops.size,1,'单动作预览只生成一个纹理');
  const preview=await pending;
  run.wardrobe.activate(preview);
  assert.deepEqual(Object.keys(preview.actor.clips),['idle-south'],'预览外观只合成 idle-south');
  assert.equal(run.textures.size,1);
  const fullPending=run.prepare();
  const full=await fullPending;
  run.wardrobe.activate(full);
  assert.deepEqual(Object.keys(full.actor.clips).sort(),['attack-north','idle-south'],'缺省仍合成整套动作');
  assert.equal(run.textures.size,3);
  assert.notEqual(await run.prepare({clipNames:['idle-south']}),full,'单动作与整套外观分开缓存');
});

test('learned skills limit which skill poses an outfit composes',async t=>{
  const run=setup(t,true,true);
  const unlearned=await run.prepare({learnedSkills:new Set()});
  assert.deepEqual(Object.keys(unlearned.actor.clips).sort(),['attack-north','idle-south'],'未学技能时不合成技能姿态');
  const learned=await run.prepare({learnedSkills:new Set(['firestorm'])});
  assert.deepEqual(Object.keys(learned.actor.clips).sort(),['attack-north','idle-south','skill-firestorm-south'],'学会后才合成对应技能姿态');
  run.wardrobe.destroy();
});

test('companion wardrobe cache keeps a global LRU bound and protects in-use members',()=>{
  const cache=new Map<string,{id:string;destroy():void}>(),destroyed:string[]=[],protectedIds=new Set<string>();
  const acquire=(id:string)=>acquireCompanionWardrobe(cache,id,()=>({id,destroy(){destroyed.push(id);}}),
    {keep:value=>protectedIds.has(value)});
  for(let index=0;index<COMPANION_WARDROBE_LIMIT;index++)acquire(`member-${index}`);
  assert.equal(cache.size,COMPANION_WARDROBE_LIMIT);
  acquire('member-0');
  acquire('member-extra');
  assert.equal(cache.size,COMPANION_WARDROBE_LIMIT,'超过上限后仍保持上限');
  assert.equal(cache.has('member-0'),true,'刚用过的成员保留');
  assert.equal(cache.has('member-1'),false,'最久未使用的成员被淘汰');
  protectedIds.add('member-2');
  acquire('member-extra-2');
  assert.equal(cache.has('member-2'),true,'正在使用的成员不淘汰');
  assert.equal(cache.has('member-3'),false,'跳过受保护成员后淘汰下一个最久未使用的');
  assert.deepEqual(destroyed,['member-1','member-3']);
});

function sharedSetup(t: test.TestContext) {
  const run = setup(t); run.wardrobe.destroy();
  const items = { items: {} } as ItemCatalog;
  const pool = new OutfitPool(run.scene, run.catalog, items);
  const create = () => new Wardrobe({ ...run.scene, events: new EventEmitter() } as unknown as Phaser.Scene,
    run.catalog, items, undefined, pool);
  t.after(() => pool.destroy());
  return { ...run, pool, create, items };
}

test('shared restoration wait survives one requester leaving and ends with the last requester',async t=>{
  const f=sharedSetup(t),renderer=Object.assign(f.renderer,{contextLost:true}),first=f.create(),second=f.create();
  const a=first.prepare(f.actor,{},'hero'),b=second.prepare(f.actor,{},'hero');
  const rejected=assert.rejects(a,{name:'AbortError'});first.destroy();await rejected;
  assert.equal(f.ops.size,0);assert.equal(renderer.listenerCount('restorewebgl'),2);
  renderer.contextLost=false;renderer.emit('restorewebgl');
  const outfit=await b;assert.equal(outfit.textures.length,1);
  second.destroy();
});

test('repeated context interruption stops after two retries and leaves no partial textures',async t=>{
  const f=setup(t),create=f.scene.textures.addDynamicTexture.bind(f.scene.textures);
  t.mock.method(f.scene.textures,'addDynamicTexture',(...args:Parameters<typeof create>)=>{
    const texture=create(...args)!;const render=texture.render.bind(texture);
    texture.render=()=>{render();f.renderer.emit('restorewebgl');return texture;};
    return texture;
  });
  await assert.rejects(f.prepare(),/绘图服务反复中断/);
  assert.equal(f.ops.size,3);assert.equal(f.textures.size,0);
  f.wardrobe.destroy();
});

test('world and stage share an outfit across shutdown and returning to the map', async t => {
  const run = sharedSetup(t), world = run.create(), stage = run.create();
  const first = world.prepare(run.actor, {}, 'hero'); const outfit = await first; world.activate(outfit);
  const other = await stage.prepare(run.actor, {}, 'hero'); stage.activate(other);
  assert.equal(other, outfit); assert.equal(run.ops.size, 1);
  world.destroy(); assert.equal(run.textures.size, 1, '舞台仍持有纹理');
  stage.destroy();
  const next = run.create(), reused = await next.prepare(run.actor, {}, 'hero');
  assert.equal(reused, outfit); assert.equal(run.ops.size, 1, '回图不重新合成');
  next.destroy(); run.pool.destroy(); assert.equal(run.textures.size, 0);
});

test('cancelling one shared preparation leaves the other scene waiting for the same result', async t => {
  const run = sharedSetup(t), first = run.create(), second = run.create();
  const a = first.prepare(run.actor, {}, 'hero'), b = second.prepare(run.actor, {}, 'hero');
  const rejected = assert.rejects(a, { name: 'AbortError' }); first.destroy(); await rejected;
  assert.equal(run.ops.size, 1); const outfit = await b; assert.equal(run.textures.size, 1); second.activate(outfit);
  run.renderer.emit('restorewebgl');
  assert.equal(run.ops.get(outfit.textures[0])!.renders, 2, '共享外观只重绘一次');
  second.destroy();
});

test('changing the worn recipe creates a new outfit and returning to it reuses the old one', async t => {
  const run = sharedSetup(t), wardrobe = run.create();
  const a = wardrobe.prepare(run.actor, {}, 'hero'); const first = await a; wardrobe.activate(first);
  run.catalog.variants.other = [];
  run.catalog.equipment.coat = { main: { body: 'other' }, offHand: {} };
  run.items.items.coat = { kind: 'armor', equipment: {} } as ItemCatalog['items'][string];
  const b = wardrobe.prepare(run.actor, { body: 'coat' }, 'hero'); const second = await b; wardrobe.activate(second);
  assert.notEqual(first, second);
  assert.equal(await wardrobe.prepare(run.actor, {}, 'hero'), first);
  wardrobe.destroy();
});

test('shared outfit cache evicts the oldest idle result and protects the active outfit', async t => {
  const run = sharedSetup(t), active = run.create();
  const initial = active.prepare(run.actor, {}, 'hero'); const protectedOutfit = await initial; active.activate(protectedOutfit);
  const created: string[] = [];
  for (let i = 0; i < OUTFIT_CACHE_LIMIT + 2; i++) {
    const wardrobe = run.create(), pending = wardrobe.prepare({ ...run.actor, id: 'hero-' + i }, {}, 'hero');
    const outfit = await pending; created.push(outfit.textures[0]); wardrobe.destroy();
  }
  assert.equal(run.textures.size, OUTFIT_CACHE_LIMIT);
  assert.ok(run.textures.has(protectedOutfit.textures[0])); assert.ok(!run.textures.has(created[0]));
  active.destroy();
});

test('session disposal waits for live users and prevents pending results from reviving the old pool', async t => {
  const run = sharedSetup(t), live = run.create(), pending = run.create();
  const loaded = live.prepare(run.actor, {}, 'hero'); const outfit = await loaded; live.activate(outfit);
  const loading = pending.prepare({ ...run.actor, id: 'other' }, {}, 'hero');
  const rejected = assert.rejects(loading, { name: 'AbortError' }); run.pool.destroy(); await rejected;
  assert.ok(run.textures.has(outfit.textures[0]), '场景释放之前保留正在显示的外观');
  live.destroy(); pending.destroy(); assert.equal(run.textures.size, 0);
  await assert.rejects(run.create().prepare(run.actor, {}, 'hero'), { name: 'AbortError' });
});

test('cached outfits keep their source parts alive until the session pool is cleared', async t => {
  const run = sharedSetup(t), source = { kind: 'image' as const, key: 'parts', file: 'parts.png' };
  run.catalog.textures.push(source); run.textures.add(source.key);
  const map = retainLoadedSceneAssets(run.scene, [source]);
  const wardrobe = run.create(), pending = wardrobe.prepare(run.actor, {}, 'hero'); await pending;
  map.release(); wardrobe.destroy(); assert.ok(run.textures.has(source.key), '缓存仍能从部件重绘');
  run.pool.destroy(); assert.equal(run.textures.size, 0);
});

test('skipping the sole outfit requester cancels composition and discards pending composition', async t => {
  const run = sharedSetup(t), wardrobe = run.create(), skip = new AbortController();
  const pending = wardrobe.prepare(run.actor, {}, 'hero', { signal: skip.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); skip.abort(); await rejected;
  assert.equal(run.textures.size, 0); const replacement = wardrobe.prepare(run.actor, {}, 'hero');
  assert.equal(run.ops.size, 2); await replacement;
  assert.equal(run.textures.size, 1); wardrobe.destroy();
});


test('nonvisual equipment reuses the current outfit without additional texture work', async t => {
  const f=setup(t);
  f.catalog.equipment.charm={main:{},offHand:{}};
  const first=await f.prepare();f.wardrobe.activate(first);
  const count=f.ops.size;
  const second=await f.wardrobe.prepare(f.actor,{ring:'charm'},'hero');
  assert.equal(second,first);assert.equal(f.ops.size,count);
  f.wardrobe.destroy();assert.equal(f.textures.size,0);
});

test('large poses flush at most 128 parts per render and remain redrawable', async t => {
  const f=setup(t);
  f.catalog.defaults.body='body';f.catalog.variants.body=['part'];
  f.catalog.sprites.part={texture:'source',x:0,y:0,width:8,height:8,anchorX:4,anchorY:4};
  f.catalog.poses.idle.frames=[Array.from({length:257},()=>({part:'body',piece:0,x:0,y:0,scaleX:1,scaleY:1,angle:0,alpha:1}))];
  const outfit=await f.prepare();
  const op=[...f.ops.values()][0];
  assert.equal(op.stamps,257);assert.equal(op.renders,3);
  outfit.redraw();assert.equal(op.stamps,514);
  f.wardrobe.destroy();
});

test('lost WebGL waits before allocating and resumes only after renderer restoration',async t=>{
  const f=setup(t),renderer=Object.assign(f.renderer,{contextLost:true});
  const pending=f.prepare();
  assert.equal(f.ops.size,0);
  renderer.emit('restorewebgl');
  await Promise.resolve();assert.equal(f.ops.size,0,'未恢复时的通知不能开始合成');
  renderer.contextLost=false;renderer.emit('restorewebgl');
  const outfit=await pending;
  assert.equal(outfit.textures.length,1);
  assert.equal(renderer.listenerCount('restorewebgl'),1,'只保留外观池本身的监听');
  f.wardrobe.destroy();assert.equal(renderer.listenerCount('restorewebgl'),0);
});

test('closing a scene cancels restoration waiting and late restoration creates nothing',async t=>{
  const f=setup(t),renderer=Object.assign(f.renderer,{contextLost:true});
  const pending=f.prepare(),rejected=assert.rejects(pending,{name:'AbortError'});
  f.events.emit('shutdown');await rejected;
  renderer.contextLost=false;renderer.emit('restorewebgl');
  await Promise.resolve();assert.equal(f.ops.size,0);assert.equal(renderer.listenerCount('restorewebgl'),0);
});

test('restoration timeout reports a recoverable error and removes waiting listeners',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup(t);Object.assign(f.renderer,{contextLost:true});
  const pending=f.prepare(),rejected=assert.rejects(pending,/绘图服务未能恢复/);
  t.mock.timers.tick(15000);await rejected;
  assert.equal(f.renderer.listenerCount('restorewebgl'),1);assert.equal(f.ops.size,0);
  f.wardrobe.destroy();
});

test('restoration during composition discards partial textures and redraws every requested clip',async t=>{
  const f=setup(t,true),create=f.scene.textures.addDynamicTexture.bind(f.scene.textures);
  let restored=false;
  t.mock.method(f.scene.textures,'addDynamicTexture',(...args:Parameters<typeof create>)=>{
    const texture=create(...args)!;const render=texture.render.bind(texture);
    texture.render=()=>{render();if(!restored){restored=true;f.renderer.emit('restorewebgl');}return texture;};
    return texture;
  });
  const outfit=await f.prepare();
  assert.equal(f.ops.size,3,'首个半成品丢弃，再完整生成两个动作');
  assert.equal(f.textures.size,2);
  assert.deepEqual([...f.textures],outfit.textures);
  assert.equal(f.textures.has([...f.ops.keys()][0]!),false);
  f.wardrobe.destroy();
});

test('failed texture allocation is diagnosed, cleaned and can be retried',async t=>{
  const f=setup(t),create=f.scene.textures.addDynamicTexture.bind(f.scene.textures),records:unknown[]=[];
  const previous=globalThis.storyDiagnostics;
  globalThis.storyDiagnostics={record:(kind:string,details:unknown)=>{records.push({kind,details});}} as unknown as typeof previous;
  t.after(()=>{globalThis.storyDiagnostics=previous;f.wardrobe.destroy();});
  let fail=true;
  t.mock.method(f.scene.textures,'addDynamicTexture',(...args:Parameters<typeof create>)=>{
    const texture=create(...args);if(fail){fail=false;throw new Error('Framebuffer status: Framebuffer Unsupported');}return texture;
  });
  await assert.rejects(f.prepare(),/人物外观绘制失败/);
  assert.equal(f.textures.size,0);
  assert.ok(records.some(value=>(value as {kind:string}).kind==='outfit-texture-error'));
  assert.equal((await f.prepare()).textures.length,1);
});

test('both device texture dimensions are checked before allocation',async t=>{
  const f=setup(t);
  Object.assign(f.renderer,{gl:{isContextLost:()=>false,MAX_TEXTURE_SIZE:1,MAX_RENDERBUFFER_SIZE:2,getParameter:(key:number)=>key===1?1024:256}});
  f.catalog.defaults.body='body';f.catalog.variants.body=['part'];
  f.catalog.sprites.part={texture:'source',x:0,y:0,width:8,height:300,anchorX:0,anchorY:0};
  f.catalog.poses.idle.frames=[[{part:'body',piece:0,x:0,y:0,scaleX:1,scaleY:1,angle:0,alpha:1}]];
  await assert.rejects(f.prepare(),/人物外观绘制失败/);
  assert.equal(f.ops.size,0,'高度超过绘图缓冲上限时不申请纹理');
  f.wardrobe.destroy();
});

test('byte budget evicts idle outfits before allocation and protects live outfits',async t=>{
  const f=sharedSetup(t);
  f.catalog.defaults.body='body';f.catalog.variants.body=['part'];
  f.catalog.sprites.part={texture:'source',x:0,y:0,width:1022,height:1022,anchorX:0,anchorY:0};
  f.catalog.poses.idle.frames=Array.from({length:3},()=>[{part:'body',piece:0,x:0,y:0,scaleX:1,scaleY:1,angle:0,alpha:1}]);
  const acquire=(id:string)=>f.pool.acquire({...f.actor,id},{},'hero',undefined,new AbortController().signal);
  const active=await acquire('active'),idle=await acquire('idle');idle.release();
  const next=await acquire('next');
  assert.ok(active.outfit.textures.every(key=>f.textures.has(key)));
  assert.ok(idle.outfit.textures.every(key=>!f.textures.has(key)),'不到8套也按实际尺寸回收闲置纹理');
  assert.ok(next.outfit.textures.every(key=>f.textures.has(key)));
  active.release();next.release();
});
