import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { BasicAttackRepeat } from '../src/domain/basic-attack-repeat.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { CHEST_OPEN_MS, nearInteractable } from '../src/domain/chests.ts';
import type { ActorDefinition, EntityPlacement, Facing, WorldIndex, WorldMap } from '../src/domain/content.ts';
import { rollChestLoot, type DropCatalog } from '../src/domain/drops.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { NavigationWorld, mirroredCollision } from '../src/domain/navigation-world.ts';
import { Session } from '../src/domain/session.ts';

class Rectangle {
  x:number;y:number;width:number;height:number;
  constructor(x:number,y:number,width:number,height:number) {this.x=x;this.y=y;this.width=width;this.height=height;}
  static Contains(area:Rectangle,x:number,y:number):boolean {return x>=area.x&&y>=area.y&&x<=area.x+area.width&&y<=area.y+area.height;}
}

// 仅替换 Phaser 的绘制边界；角色创建、事件注册、目标选择、开箱、随机掉落及会话状态均跑生产代码。
class Display extends EventEmitter {
  x:number;y:number;visible=true;active=true;alpha=1;width=0;height=0;
  list:Display[]=[];
  input?:{enabled:boolean;hitArea:Rectangle;hitAreaCallback:typeof Rectangle.Contains};
  anims={timeScale:1,accumulator:0};
  constructor(x=0,y=0) {super();this.x=x;this.y=y;}
  setDepth() {return this;} setOrigin() {return this;} setBlendMode() {return this;} setScale() {return this;}
  setAlpha(value:number) {this.alpha=value;return this;} setVisible(value:boolean) {this.visible=value;return this;}
  addAt(value:Display,index:number) {this.list.splice(index,0,value);return this;}
  setInteractive(hitArea:Rectangle,hitAreaCallback:typeof Rectangle.Contains) {this.input={enabled:true,hitArea,hitAreaCallback};return this;}
  disableInteractive() {if(this.input)this.input.enabled=false;return this;}
  play() {return this;} destroy() {this.active=false;this.removeAllListeners();}
}
const boundary=Symbol.for('inotia.chest-interaction-test.phaser');
Object.defineProperty(globalThis,boundary,{value:{Rectangle},configurable:true});
const phaser=registerHooks({resolve(specifier,context,next) {
  return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(`
    const {Rectangle}=globalThis[Symbol.for('inotia.chest-interaction-test.phaser')];
    export default {Geom:{Rectangle},BlendModes:{NORMAL:0,ADD:1,SCREEN:2,MULTIPLY:3},Scene:class{},Physics:{Arcade:{Body:class{}}}};
  `)}`}:next(specifier,context);
}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
phaser.deregister();

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8')) as T;
const world=read<WorldIndex>('content/world.json'),campaign=read<Campaign>('content/campaign.json');
const items=read<ItemCatalog>('content/items.json'),stats=read<CharacterStatsCatalog>('content/character-stats.json');
const drops=read<DropCatalog>('content/drops.json');
const maps=world.maps.map(reference=>read<WorldMap>(reference.file));
const sourceMap=maps.find(map=>map.id==='shadow-forest-west')!;
const sourceChest=sourceMap.entities.find(entity=>world.actors[entity.actor].chest==='ordinary')!;

interface Character {entity:EntityPlacement;actor:ActorDefinition;container:Display;marker:null}
interface SceneHooks {
  createActor(entity:EntityPlacement):Character;
  openChest(character:Character,requireFacing?:boolean):void;
  attackKey():void;
  updateInteractionTarget():void;
  refreshState():void;
  syncHud():void;
}

function fixture(map:WorldMap,entity:EntityPlacement,session=new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items))) {
  session.chests.enterMap(map.id);
  const calls:string[]=[],navigation=new NavigationWorld(map),enabled=new Map<Character,boolean>();
  for(const other of map.entities)if(other.id!==entity.id)navigation.register({
    shape:()=>({collision:mirroredCollision(world.actors[other.actor].collision,other.flip)}),position:()=>other,enabled:()=>true
  });
  const animations=new Set<string>();
  const tweens:{duration:number;ease:(value:number)=>number;onComplete:()=>void;pause:()=>void;resume:()=>void;paused:boolean}[]=[];
  const combat={controlledVisual:undefined as {container:Display}|undefined,controlledMember:{level:100},
    facing:'south' as Facing,cannotAct:false,playerCannotAct:()=>combat.cannotAct,
    syncChestEnemies:()=>calls.push('enemies'),hasHostileTarget:()=>true,
    attack:()=>calls.push('attack'),setPerformanceActive() {}};
  const state={
    app:{world,items,session,campaign:{quests:[]},locked:false,suspended:false,characterStats:stats,
      ui:{ready:true,controlLayoutEditing:false},audio:{ui:(sound:string)=>calls.push(sound)}},
    map,dropCatalog:drops,player:{container:new Display()},characters:[] as Character[],near:null as Character|null,
    combat,autoAttack:new BasicAttackRepeat(),performing:false,loadingWorld:false,active:true,
    chestFades:new Map(),sys:{isActive:()=>state.active},
    add:{container:(x:number,y:number)=>new Display(x,y),sprite:()=>new Display()},
    anims:{exists:(key:string)=>animations.has(key),create:({key}:{key:string})=>animations.add(key),generateFrameNumbers:()=>[]},
    movement:{navigation,register:(character:Character)=>{
      enabled.set(character,true);navigation.register({
        shape:()=>({collision:mirroredCollision(character.actor.collision,character.entity.flip)}),
        position:()=>character.container,enabled:()=>enabled.get(character)??false
      });
    },setEnabled:(character:Character,value:boolean)=>enabled.set(character,value)},
    tweens:{add:(options:{duration:number;ease:(value:number)=>number;onComplete:()=>void})=>{
      const tween={...options,paused:false,pause:()=>{tween.paused=true;},resume:()=>{tween.paused=false;}};
      tweens.push(tween);return tween;
    }},
    refreshCombatTarget() {},refreshLoadout() {}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as SceneHooks;
  const chest=scene.createActor({...entity});state.characters.push(chest);
  const position=(x:number,y:number)=>Object.assign((combat.controlledVisual??state.player).container,{x,y});
  const click=(x?:number,y?:number)=>{
    const input=chest.container.input;
    if(!chest.container.visible||!input?.enabled)return false;
    const area=input.hitArea,localX=x??area.x+area.width/2,localY=y??area.y+area.height/2;
    if(!input.hitAreaCallback(area,localX+chest.container.width/2,localY+chest.container.height/2))return false;
    chest.container.emit('pointerdown',{id:1},localX,localY,{stopPropagation:()=>calls.push('stopPropagation')});
    return true;
  };
  return {scene,state,chest,calls,tweens,combat,session,navigation,enabled,position,click,
    opened:()=>session.chests.isOpened(map.id,entity.id),loot:()=>groundLootFor(session).forMap(map.id)};
}

/** 开箱入口的边界用空地隔离地形；全地图测试另行使用原始地形和全部占位。 */
function arena(actor=sourceChest.actor) {
  const entity={...sourceChest,actor,x:256,y:256};
  return {entity,map:{...sourceMap,entities:[entity],blocked:sourceMap.blocked.map(()=>false)}};
}

test('every real map chest registers a clickable image and opens from a legal approach position',t=>{
  t.mock.method(Math,'random',()=>0);
  let checked=0;
  for(const map of maps)for(const entity of map.entities) {
    const kind=world.actors[entity.actor].chest;if(!kind)continue;
    const f=fixture(map,entity),clip=f.chest.actor.clips['idle-south']!;
    assert(f.chest.container.input,`${map.name}/${entity.id} 注册点击`);
    assert.equal(f.click(9999,9999),false,'贴图范围外没有命中');
    let approached=false;
    for(let dy=-24;dy<=24&&!approached;dy+=4)for(let dx=-24;dx<=24&&!approached;dx+=4) {
      const point={x:entity.x+dx,y:entity.y+dy};
      if(!nearInteractable(point,entity)||!f.navigation.canPlace(world.actors.kiyan,point))continue;
      f.position(point.x,point.y);approached=true;
    }
    assert(approached,`${map.name}/${entity.id} 有近身站位`);
    assert.equal(f.chest.container.input.hitArea.width,clip.frameWidth);
    assert.equal(f.chest.container.input.hitArea.height,clip.frameHeight);
    assert(f.click());assert(f.opened(),`${map.name}/${entity.id} 实际点击后已开`);
    assert.equal(f.enabled.get(f.chest),false);assert.equal(f.tweens[0].duration,CHEST_OPEN_MS);
    assert.equal(f.calls.filter(call=>call==='chestOpen').length,1);
    // 宝箱自己站在可走地形上时，掉落留在原位；原版有两处箱子压在阻挡格，掉落就近吸附到可站格。
    const atChest=f.navigation.terrainFree({x:entity.x,y:entity.y});
    for(const drop of f.loot()){
      assert.equal(f.navigation.terrainFree({x:drop.x,y:drop.y}),true,`${map.name}/${entity.id} 掉落物落在可站地形`);
      if(atChest)assert.deepEqual({x:drop.x,y:drop.y},{x:entity.x,y:entity.y});
    }
    checked++;
  }
  assert.equal(checked,87);
});

test('a story-placed BOSS treasure chest opens with the improved three-pass drops',t=>{
  const actor='story-boss-treasure-chest-59456ff6';
  assert.equal(world.actors[actor].chest,'improved','NPC 212 在原版链到开箱功能 37');
  const {map,entity}=arena(actor);
  const boss={...entity,id:'story-object-test-0-0',characterId:'npc-212'};
  const bossMap={...map,entities:[boss]};
  t.mock.method(Math,'random',()=>0);
  const clicked=fixture(bossMap,boss);
  clicked.position(boss.x-24,boss.y);
  assert(clicked.click());assert(clicked.opened());
  const expected=rollChestLoot(drops,stats,'improved',bossMap.chestLevel??((bossMap.lootLevel??0)>0?bossMap.lootLevel!:1),clicked.session.hero!.level,()=>0);
  assert.deepEqual(clicked.loot().map(drop=>drop.reward.kind==='item'
    ?{kind:'item',item:drop.reward.item,quantity:drop.reward.quantity}:drop.reward),
  expected.rewards.map(reward=>reward.kind==='item'?{kind:'item',item:reward.item,quantity:reward.quantity}:reward),'BOSS 宝箱走三连掉落');
  const attacked=fixture(bossMap,{...boss});
  attacked.position(boss.x+24,boss.y);attacked.combat.facing='west';
  attacked.scene.attackKey();assert(attacked.opened(),'攻击键同样能开 BOSS 宝箱');
});

test('every treasure actor opens with the attack key from each side while facing the chest, even with a hostile target',t=>{
  t.mock.method(Math,'random',()=>.9999);
  for(const actor of Object.values(world.actors).filter(actor=>actor.chest))for(const side of [
    {dx:-24,dy:0,facing:'east'},{dx:24,dy:0,facing:'west'},
    {dx:0,dy:-24,facing:'south'},{dx:0,dy:24,facing:'north'}
  ] as const) {
    const {map,entity}=arena(actor.id),f=fixture(map,entity);
    f.position(entity.x+side.dx,entity.y+side.dy);f.combat.facing=side.facing;
    f.scene.attackKey();assert(f.opened(),`${actor.name}/${side.facing}`);
    assert.equal(f.calls.includes('attack'),false);assert.equal(f.state.autoAttack.active,false);
  }
});

test('manual opening keeps the separate click distance and attack-key facing rules and never moves the character',t=>{
  t.mock.method(Math,'random',()=>.9999);
  const {map,entity}=arena(),f=fixture(map,entity);
  f.position(entity.x-25,entity.y);f.combat.facing='east';f.scene.attackKey();
  assert.equal(f.opened(),false,'攻击键 25px 尚未选到箱子');assert(f.calls.includes('attack'));
  f.position(entity.x-24,entity.y);f.combat.facing='west';f.scene.attackKey();
  assert.equal(f.opened(),false,'背向箱子不会由攻击键开箱');
  f.position(entity.x-65,entity.y);assert(f.click());assert.equal(f.opened(),false,'点击距离超界');
  assert.deepEqual([f.state.player.container.x,f.state.player.container.y],[entity.x-65,entity.y]);
  f.position(entity.x-64,entity.y);assert(f.click());assert(f.opened(),'直接点击够得着即可，不要求转身');
  assert.deepEqual([f.state.player.container.x,f.state.player.container.y],[entity.x-64,entity.y]);
});

test('a controlled companion supplies position and facing while treasure drops still use the hero level',t=>{
  t.mock.method(Math,'random',()=>.5);
  const {map,entity}=arena(),f=fixture({...map,lootLevel:1},entity);
  const rules=structuredClone(drops);
  for(const kind of Object.keys(rules.chests.ordinary.chances) as (keyof typeof rules.chests.ordinary.chances)[])rules.chests.ordinary.chances[kind]=0;
  rules.chests.ordinary.chances.money=9000;rules.chests.ordinary.uniqueChance.numerator=0;delete rules.chests.ordinary.spawn;
  f.state.dropCatalog=rules;
  f.combat.controlledVisual={container:new Display(entity.x+24,entity.y)};f.combat.facing='west';
  f.scene.attackKey();assert(f.opened());
  assert.deepEqual(f.loot().map(drop=>drop.reward),[{kind:'money',amount:30}]);

  const distant=fixture(map,entity);distant.state.player.container=new Display(entity.x-24,entity.y);
  distant.combat.controlledVisual={container:new Display(entity.x+100,entity.y)};
  distant.click();assert.equal(distant.opened(),false,'主角在箱旁也不能代替远处的受控队员开箱');
});

test('all six scenery or story box placements stay outside the random treasure interaction',t=>{
  const actors=new Set(['box-5f6f8808','old-box-1d5f38b4','treasure-box-5ea1dd1f','treasure-box-0b584b3d','treasure-box-aa819e7d']);
  let checked=0;
  for(const map of maps)for(const entity of map.entities)if(actors.has(entity.actor)) {
    // 人物初始化可能用随机数；只监视开箱输入期间的随机抽取。
    t.mock.restoreAll();const f=fixture(map,entity);
    t.mock.method(Math,'random',()=>{assert.fail('场景箱没有掉落抽取');});
    assert.equal(f.chest.container.input,undefined);f.position(entity.x-24,entity.y);f.combat.facing='east';
    f.scene.openChest(f.chest,false);f.scene.attackKey();
    assert.equal(f.opened(),false);assert.deepEqual(f.loot(),[]);assert.equal(f.tweens.length,0);checked++;
  }
  assert.equal(checked,6);
});

test('menu, suspension, control editing, unavailable actors and loading reject stale opening events',t=>{
  const {map,entity}=arena();
  const guards:((f:ReturnType<typeof fixture>)=>void)[]=[
    f=>{f.state.app.locked=true;},f=>{f.state.app.suspended=true;},f=>{f.state.app.ui.controlLayoutEditing=true;},
    f=>{f.state.app.ui.ready=false;},f=>{f.state.loadingWorld=true;},f=>{f.state.performing=true;},
    f=>{f.state.active=false;},f=>{f.combat.cannotAct=true;},f=>{f.chest.container.visible=false;}
  ];
  for(const guard of guards) {
    t.mock.restoreAll();const f=fixture(map,entity);f.position(entity.x-24,entity.y);f.combat.facing='east';guard(f);
    t.mock.method(Math,'random',()=>{assert.fail('被拦截的开箱事件没有随机结算');});
    f.scene.openChest(f.chest,false);f.scene.attackKey();
    assert.equal(f.opened(),false);assert.deepEqual(f.loot(),[]);assert.equal(f.tweens.length,0);
    assert.equal(f.calls.includes('chestOpen'),false);assert.equal(f.enabled.get(f.chest),true);
  }
});

test('opening settles once, frees collision, spawns original rewards and pauses the 600ms fade with the menu',t=>{
  const {map,entity}=arena(),f=fixture(map,entity);f.position(entity.x-24,entity.y);
  t.mock.method(Math,'random',()=>0);
  const expected=rollChestLoot(drops,stats,'ordinary',map.chestLevel??((map.lootLevel??0)>0?map.lootLevel!:1),f.session.hero!.level,()=>0);
  assert.equal(f.navigation.canPlace(world.actors.kiyan,entity),false,'未开箱占位');
  f.click();
  assert(f.opened());assert.equal(f.chest.container.input!.enabled,false);
  assert(f.navigation.canPlace(world.actors.kiyan,entity),'开箱立即释放实体阻挡');
  assert.deepEqual(f.loot().map(drop=>drop.reward.kind==='item'?{kind:'item',item:drop.reward.item,quantity:drop.reward.quantity}:drop.reward),
    expected.rewards.map(reward=>reward.kind==='item'?{kind:'item',item:reward.item,quantity:reward.quantity}:reward));
  assert.deepEqual(f.session.chests.spawns.map(spawn=>spawn.enemyId),expected.enemies);
  const settled=f.loot();f.scene.openChest(f.chest,false);assert.equal(f.click(),false);
  assert.deepEqual(f.loot(),settled);assert.equal(f.calls.filter(call=>call==='chestOpen').length,1);assert.equal(f.tweens.length,1);
  const tween=f.tweens[0];assert.equal(tween.duration,600);assert.equal(tween.ease(.19),.1);
  f.state.app.locked=true;f.scene.syncHud();assert(tween.paused);
  f.state.app.locked=false;f.scene.syncHud();assert.equal(tween.paused,false);
  tween.onComplete();assert.equal(f.chest.container.visible,false);assert.equal(f.state.chestFades.size,0);
});

test('an empty random result still opens, sounds and removes the treasure',t=>{
  const {map,entity}=arena(),f=fixture(map,entity);f.position(entity.x-24,entity.y);
  t.mock.method(Math,'random',()=>.9999);f.click();
  assert(f.opened());assert.deepEqual(f.loot(),[]);assert.deepEqual(f.session.chests.spawns,[]);
  assert(f.calls.includes('chestOpen'));assert.equal(f.enabled.get(f.chest),false);
  f.tweens[0].onComplete();assert.equal(f.chest.container.visible,false);
});

test('rebuilding and restoring an opened chest keeps it hidden; visiting another map restores a fresh chest',t=>{
  const {map,entity}=arena(),f=fixture(map,entity);f.position(entity.x-24,entity.y);
  t.mock.method(Math,'random',()=>.9999);f.click();f.tweens[0].onComplete();
  const snapshot=f.session.chests.captureState(),rebuilt=fixture(map,entity,f.session);
  rebuilt.scene.refreshState();assert.equal(rebuilt.chest.container.visible,false);assert.equal(rebuilt.enabled.get(rebuilt.chest),false);
  rebuilt.position(entity.x-24,entity.y);rebuilt.scene.updateInteractionTarget();assert.equal(rebuilt.state.near,null);
  const restored=fixture(map,entity);restored.session.chests.restoreState(snapshot);restored.scene.refreshState();
  assert.equal(restored.chest.container.visible,false);assert.equal(restored.enabled.get(restored.chest),false);
  f.session.chests.enterMap('another-map');const returned=fixture(map,entity,f.session);
  returned.scene.refreshState();assert.equal(returned.chest.container.visible,true);assert.equal(returned.enabled.get(returned.chest),true);
  returned.position(entity.x-24,entity.y);assert(returned.click());assert(returned.opened());
});
