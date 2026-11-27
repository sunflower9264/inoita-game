import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {parseBattle} from '../src/application/content-validation.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}
  :next(specifier,context);}});
const {BuffLoopRenderer}=await import('../src/rendering/buff-loop-renderer.ts');
const {CombatStatusVisuals}=await import('../src/rendering/combat-status-visuals.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const unit=catalog.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
assert.equal(unit.effect,'buff');if(unit.effect!=='buff')throw new Error('Dark Strike buff missing');
const rank=unit.ranks[0];

class Sprite {
  alpha=1;scaleX=1;repeat=0;origin={x:0,y:0};
  anims={accumulator:0,currentFrame:{index:1},currentAnim:{frames:Array.from({length:6},(_,frame)=>({index:frame+1}))},
    paused:false,pause(){this.paused=true;},setCurrentFrame(frame:{index:number}){this.currentFrame=frame;}};
  setOrigin(x:number,y:number){this.origin={x,y};return this;}
  setScale(x:number){this.scaleX=x;return this;}setBlendMode(){return this;}setTexture(){return this;}setVisible(){return this;}
  play(config:{repeat:number}){this.repeat=config.repeat;return this;}
}
class Effect extends EventEmitter {
  list:Sprite[]=[];active=true;name='';readonly x:number;readonly y:number;
  constructor(x:number,y:number){super();this.x=x;this.y=y;}
  get length(){return this.list.length;}setDepth(){return this;}setName(name:string){this.name=name;return this;}
  add(sprite:Sprite){this.list.push(sprite);return this;}removeAll(){this.list=[];return this;}
  destroy(){if(!this.active)return;this.active=false;this.emit('destroy');}
}
type FakeLoopContainer={active:boolean;x:number;y:number;list:Effect[];
  add:(effect:Effect)=>void;bringToTop:(effect:Effect)=>void};
function loopContainer(nodes:Effect[],order:Effect[]):FakeLoopContainer {
  const list:Effect[]=[];
  return {active:true,x:100,y:200,list,
    add:(effect:Effect)=>{list.push(effect);nodes.push(effect);},
    // 与 Phaser 一致：把已有子对象移到列表末尾，下一帧才能走层序已正确的快路径。
    bringToTop:(effect:Effect)=>{
      const index=list.indexOf(effect);if(index<0)return;
      list.splice(index,1);list.push(effect);order.push(effect);
    }};
}
function fakeVisual(nodes:Effect[],order:Effect[]):CharacterVisual {
  return {layers:[{alpha:.5}],entity:{flip:true},container:loopContainer(nodes,order)} as unknown as CharacterVisual;
}
function fixture(){
  const nodes:Effect[]=[],order:Effect[]=[];
  const target=fakeVisual(nodes,order);
  const scene={add:{container:(x:number,y:number)=>new Effect(x,y),sprite:()=>new Sprite()},
    anims:{exists:()=>false,create:()=>{},generateFrameNumbers:()=>[]}} as unknown as Phaser.Scene;
  const renderer=new BuffLoopRenderer(scene,catalog),conditions=new CombatConditions();
  const sync=()=>renderer.sync('actor',target,conditions.buffLoopFrames('actor'));
  const replaceContainer=()=>{
    const nextNodes:Effect[]=[],nextOrder:Effect[]=[];
    (target as unknown as {container:FakeLoopContainer}).container=loopContainer(nextNodes,nextOrder);
    return {nodes:nextNodes,order:nextOrder};
  };
  conditions.applyBuff('actor','dark-strike',rank.strength,rank.effect);
  return {scene,nodes,order,target,renderer,conditions,sync,replaceContainer};
}

test('loop sync reuses visuals, skips unchanged ages and avoids reordering an ordered tail',()=>{
  const f=fixture();f.conditions.update(60);f.sync();
  assert.equal(f.nodes.length,2);assert.equal(f.order.length,0,'创建时按顺序加入');
  const [magic,soul]=f.nodes;
  soul.list[0].anims.currentFrame={index:99};
  f.sync();
  assert.equal(f.nodes.length,2);assert.equal(f.nodes[0],magic);assert.equal(f.nodes[1],soul);
  assert.equal(soul.list[0].anims.currentFrame.index,99,'同一帧龄不重设动画帧');
  assert.equal(f.order.length,0,'层序正确时不重排');
  f.conditions.update(60);f.sync();
  assert.equal(f.nodes[0],magic);assert.equal(f.nodes[1],soul);
  assert.equal(magic.list[0].anims.currentFrame.index,3,'帧龄推进时仍更新动画帧');
  assert.equal(soul.list[0].anims.currentFrame.index,3);
});

test('temporary sync containers are reused across actors without sharing loop results',()=>{
  const f=fixture(),allyNodes:Effect[]=[],allyOrder:Effect[]=[],ally=fakeVisual(allyNodes,allyOrder);
  f.conditions.applyBuff('ally','dark-strike',rank.strength,rank.effect);
  f.conditions.update(60);
  f.sync();f.renderer.sync('ally',ally,f.conditions.buffLoopFrames('ally'));
  assert.equal(f.nodes.length,2);assert.equal(allyNodes.length,2);
  assert.ok(f.nodes.every((effect,index)=>effect!==allyNodes[index]),'每个角色持有自己的特效');
  f.sync();f.renderer.sync('ally',ally,f.conditions.buffLoopFrames('ally'));
  assert.equal(f.nodes.length,2);assert.equal(allyNodes.length,2);
  assert.equal(f.order.length,0);assert.equal(allyOrder.length,0);
});

test('destroyed or incomplete loop visuals are recreated without rebuilding siblings',()=>{
  const f=fixture();f.conditions.update(60);f.sync();
  const [magic,soul]=f.nodes;
  magic.destroy();f.sync();
  assert.ok(!magic.active);
  assert.equal(f.nodes.length,3);
  assert.equal(f.nodes[1],soul,'未受影响的同组特效继续复用');
  assert.equal(f.nodes[2].name,'buff-loop:soul-sword-magic');
  assert.ok(f.nodes[2].active);
  assert.deepEqual(f.order.map(effect=>effect.name),['buff-loop:soul-sword-magic','buff-loop:soul-sword']);
  const replacement=f.nodes[2];
  f.sync();assert.equal(f.nodes.length,3);assert.equal(f.nodes[2],replacement);
  assert.equal(f.order.length,2,'重排后层序正确时不重复调用');
  soul.list.pop();f.sync();
  assert.ok(!soul.active,'层数不符的旧特效被销毁');
  assert.equal(f.nodes.length,4);
  assert.equal(f.nodes[3].name,'buff-loop:soul-sword');
  assert.ok(f.nodes[3].active);
});

test('replacing the character visual moves loop membership to the new container',()=>{
  const f=fixture();f.conditions.update(60);f.sync();
  const old=f.nodes.slice();
  const replacement=f.replaceContainer();f.sync();
  assert.ok(old.every(effect=>!effect.active),'旧容器上的特效被销毁');
  assert.equal(f.nodes.length,2,'旧容器不再接收新特效');
  assert.equal(f.order.length,0,'旧容器不再重排');
  assert.equal(replacement.nodes.length,2);
  assert.deepEqual(replacement.nodes.map(effect=>effect.name),['buff-loop:soul-sword-magic','buff-loop:soul-sword']);
  assert.ok(replacement.nodes.every(effect=>effect.active));
  const first=replacement.nodes[0];f.sync();
  assert.equal(replacement.nodes.length,2);assert.equal(replacement.nodes[0],first);
  assert.equal(replacement.order.length,0,'新容器创建时按顺序加入，层序正确后不重排');
});

test('hidden character containers keep loop membership and keep advancing frames',()=>{
  const f=fixture();f.conditions.update(60);f.sync();
  const [magic,soul]=f.nodes;
  (f.target.container as unknown as {visible:boolean}).visible=false;
  f.conditions.update(60);f.sync();
  assert.equal(f.nodes.length,2);assert.equal(f.nodes[0],magic);assert.equal(f.nodes[1],soul);
  assert.equal(magic.list[0].anims.currentFrame.index,3);
});

test('buff loops use native age frames at the feet, preserve layer order and ignore actor stealth and facing',()=>{
  const f=fixture();f.sync();assert.equal(f.nodes.length,0);
  f.conditions.update(60);f.sync();assert.equal(f.nodes.length,2);
  assert.deepEqual(f.nodes.map(effect=>effect.name),['buff-loop:soul-sword-magic','buff-loop:soul-sword']);
  assert.equal(f.order.length,0,'创建时按顺序加入，层序正确不需要重排');
  for(const effect of f.nodes){
    assert.deepEqual([effect.x,effect.y],[0,0]);
    for(const layer of effect.list){
      assert.equal(layer.anims.currentFrame.index,2);assert.equal(layer.anims.paused,true);
      assert.equal(layer.repeat,-1);assert.equal(layer.alpha,1);assert.equal(layer.scaleX,1);
    }
  }
  f.conditions.update(5*60);f.sync();
  assert.equal(f.nodes[0].list[0].anims.currentFrame.index,1);
  f.sync();assert.equal(f.nodes.length,2);
  assert.equal(f.nodes[0].list[0].anims.currentFrame.index,1);
  f.conditions.removeBuff('actor','dark-strike');f.sync();assert.ok(f.nodes.every(node=>!node.active));
});

test('accepted refresh removes old visuals at age zero, while owner removal and scene disposal release remaining loops',()=>{
  const f=fixture();f.conditions.update(60);f.sync();
  f.conditions.applyBuff('actor','dark-strike',rank.strength,rank.effect);f.sync();
  assert.ok(f.nodes.every(node=>!node.active));
  f.conditions.update(60);f.sync();assert.equal(f.nodes.length,4);
  f.renderer.retainActors(new Set());assert.ok(f.nodes.every(node=>!node.active));
  f.sync();assert.equal(f.nodes.length,6);f.renderer.clear();assert.ok(f.nodes.every(node=>!node.active));
});

test('world rendering uses current condition ages, keeps paused frames and removes formal defeat visuals',()=>{
  const f=fixture();let health=10,awaitingDefeat=false;
  const statusVisuals=new CombatStatusVisuals(f.scene,catalog);
  const sync=()=>statusVisuals.syncBuffLoops(
    f.conditions.activeAppearances(),
    ()=>f.target,
    id=>f.conditions.buffLoopFrames(id),
    ()=>health>0||awaitingDefeat,
  );
  sync();assert.equal(f.nodes.length,0);f.conditions.update(60);sync();assert.equal(f.nodes.length,2);
  const frames=f.conditions.buffLoopFrames('actor');
  sync();assert.equal(f.nodes[0].list[0].anims.currentFrame.index,2);assert.equal(f.conditions.buffLoopFrames('actor'),frames,'暂停期间复用循环帧描述');
  health=0;awaitingDefeat=true;sync();assert.ok(f.nodes.every(node=>node.active));
  awaitingDefeat=false;sync();assert.ok(f.nodes.every(node=>!node.active));
});

test('loop assets and frame gates are validated with the active skill content',()=>{
  const data=structuredClone(catalog),buff=data.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  assert.equal(buff.effect,'buff');if(buff.effect!=='buff')return;
  buff.ranks[0].effect.loopEffects![0].effect='missing-loop';
  assert.throws(()=>parseBattle(data),/missing-loop/);
  buff.ranks[0].effect.loopEffects![0].effect='soul-sword-magic';
  buff.ranks[0].effect.loopEffects![0].firstFrameAge=-1;
  assert.throws(()=>parseBattle(data),/firstFrameAge/);
});


test('a loop missing on its first frame is created after textures arrive',()=>{
  const f=fixture();let loaded=false;
  Object.assign(f.scene,{textures:{exists:()=>loaded,get:()=>({has:()=>true}),remove(){}}});
  Object.assign(f.scene.anims,{generateFrameNumbers:()=>[0,1,2,3,4,5]});
  f.conditions.update(60);f.sync();
  assert.equal(f.nodes.length,0,'缺图期间不保存空容器');
  loaded=true;f.sync();
  assert.equal(f.nodes.length,2,'同一Buff后续刷新会重试');
  assert.ok(f.nodes.every(effect=>effect.list.length>0));
  f.renderer.clear();
});
