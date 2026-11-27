import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { Session } from '../src/domain/session.ts';

import { loadBattleCatalog } from './support/combat-test-harness.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { createTestWorldCombat } from './support/world-combat-fixture.ts';

class Rectangle {
  x:number;y:number;width:number;height:number;
  constructor(x:number,y:number,width:number,height:number) {this.x=x;this.y=y;this.width=width;this.height=height;}
  static Contains(area:Rectangle,x:number,y:number):boolean {return x>=area.x&&y>=area.y&&x<=area.x+area.width&&y<=area.y+area.height;}
}
const boundary=Symbol.for('inotia.world-story-loot-test.phaser');
Object.defineProperty(globalThis,boundary,{value:{Rectangle},configurable:true});
const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(`
    const {Rectangle}=globalThis[Symbol.for('inotia.world-story-loot-test.phaser')];
    export default {Geom:{Rectangle},BlendModes:{NORMAL:0,ADD:1,SCREEN:2,MULTIPLY:3},TintModes:{FILL:0,OVERLAY:1},Core:{Events:{POST_RENDER:'postrender'}},Scenes:{Events:{SHUTDOWN:'shutdown',PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender'}},Scene:class{},Physics:{Arcade:{Body:class{}}}};
  `)}`}:next(specifier,context);
}});
const { WorldScene }=await import('../src/scenes/world-scene.ts');
phaser.deregister();

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8')) as T;
const world=read<{maps:{id:string;file:string}[]}>('content/world.json');
const campaign=read<Campaign>('content/campaign.json'),items=read<ItemCatalog>('content/items.json');
const stats=read<CharacterStatsCatalog>('content/character-stats.json');
const companions=read<CompanionCatalog>('content/companions.json');

function fixture(){
  const session=new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items));
  const mapId='shadow-camp',store=groundLootFor(session);
  store.add(mapId,10,10,[{kind:'money',amount:5},{kind:'item',item:'healing-potion-s',quantity:1}]);
  store.addFlying(mapId,{x:1,y:1},{x:5,y:5,direction:0},'mana-gem',1000);
  store.add('shadow-forest-east',10,10,[{kind:'money',amount:9}]);
  let mana=0,synced=0,messages=0,flushed=false;const sounds:string[]=[];
  const state={
    map:{id:mapId},loadingWorld:false,destroyed:false,
    app:{session,items,world,campaign,maxHealth:0,audio:{ui:(name:string)=>sounds.push(name)}},
    combat:{
      // 模拟 normalizeForStory 里 pendingDefeats.flush() 把最后一杀的掉落补进 store；只结算一次。
      normalizeForStory:async()=>{if(!flushed){flushed=true;store.add(mapId,20,20,[{kind:'money',amount:7}]);}},
      collectMana:()=>{mana++;return true;},
    },
    groundLootView:{sync:()=>{synced++;}},
    pickupMessages:{enqueue:()=>{messages++;}},
    resetInput(){},
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as {
    normalizeForStory(signal:AbortSignal):Promise<void>;
  };
  return {session,store,mapId,scene,mana:()=>mana,synced:()=>synced,messages:()=>messages,sounds:()=>sounds};
}

test('loot landing stays off map exits',()=>{
  const exits=[{x:32,y:32,width:64,height:64}];
  const navigation={
    terrainFree:()=>true,
    nearest:(_shape:unknown,_point:{x:number;y:number},_ignore:unknown,_placements:unknown,
      extra?: (point:{x:number;y:number})=>boolean)=>{
      return [{x:40,y:40},{x:100,y:100}].find(point=>!extra||extra(point))!;
    },
  };
  const host={map:{id:'exit-map',exits},movement:{navigation}};
  const landing=(Reflect.get(WorldScene.prototype,'lootLanding') as
    (map:string,x:number,y:number)=>{x:number;y:number}).call(host,'exit-map',40,40);
  assert.deepEqual(landing,{x:100,y:100},'落点压住出口时换到最近的非出口可站点');
  assert.deepEqual((Reflect.get(WorldScene.prototype,'lootLanding') as
    (map:string,x:number,y:number)=>{x:number;y:number}).call(host,'exit-map',200,200),{x:200,y:200});
});

test('story normalization collects the current map before the performance takes control',async()=>{
  const run=fixture(),beforeItems=run.session.itemCount('healing-potion-s');
  await run.scene.normalizeForStory(new AbortController().signal);
  assert.equal(run.session.money,12,'本图货币与 flush 补入的掉落都已入账');
  assert.equal(run.session.itemCount('healing-potion-s'),beforeItems+1);
  assert.equal(run.mana(),1,'飞行中的魔法宝石也按战斗资源结算');
  assert.deepEqual(run.store.forMap(run.mapId),[]);
  assert.equal(run.store.forMap('shadow-forest-east').length,1,'其他地图的地面掉落保持原样');
  assert.equal(run.messages(),0,'自动拾取不刷逐件拾取飘字');
  assert.ok(run.synced()>=1,'地面图标同步移除');
});

test('walking over ordinary ground loot plays one pickup sound',()=>{
  const run=fixture(),money=run.session.money,potions=run.session.itemCount('healing-potion-s');
  const collect=Reflect.get(WorldScene.prototype,'collectGroundLoot') as
    (this:unknown,position:{x:number;y:number})=>void;
  collect.call(run.scene,{x:10,y:10});
  assert.equal(run.session.money,money+5,'钱和普通物品都照常入账');
  assert.equal(run.session.itemCount('healing-potion-s'),potions+1);
  assert.deepEqual(run.sounds(),['loot'],'一次批量拾取只播一次音效，不区分物品类型');
});

test('story normalization is idempotent when the map is already empty',async()=>{
  const run=fixture();
  await run.scene.normalizeForStory(new AbortController().signal);
  const money=run.session.money,synced=run.synced();
  await run.scene.normalizeForStory(new AbortController().signal);
  assert.equal(run.session.money,money);
  assert.equal(run.synced(),synced,'没有可收的掉落时不再重建视图');
});

test('a mana gem stays on the ground instead of rejecting story preparation when nobody can collect it',async()=>{
  const run=fixture();
  (run.scene as unknown as {combat:{collectMana:()=>boolean}}).combat.collectMana=()=>false;
  await run.scene.normalizeForStory(new AbortController().signal);
  assert.deepEqual(run.store.forMap(run.mapId).map(drop=>drop.reward),[ {kind:'item',item:'mana-gem',quantity:1} ]);
  assert.equal(run.session.money,12,'其他掉落照常入账');
});

test('mana collection falls back to a living member and leaves the gem when the whole party is down',async()=>{
  const pickup=items.items['mana-gem'].pickup!;
  const battleCatalog=loadBattleCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,stats,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const testWorld=await createTestWorldCombat({hero,session,battleCatalog,items,characterStats:stats});
  await testWorld.combat.start();
  hero.setHealth(0);
  ally.setHealth(10);
  ally.setMana(0);
  assert.equal(testWorld.combat.collectMana(pickup),true);
  assert.equal(ally.player.mana,Math.floor(ally.player.maxMana*pickup.percentOfCollectorMaxMana/100));
  hero.setHealth(0);
  ally.setHealth(0);
  assert.equal(testWorld.combat.collectMana(pickup),false,'全灭时不抛异常，让掉落留在原地');
  testWorld.combat.destroy();
});
