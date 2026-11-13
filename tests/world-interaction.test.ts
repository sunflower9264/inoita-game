import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { ActorDefinition, EntityPlacement, Facing, WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { DropCatalog } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { Session } from '../src/domain/session.ts';
import type { ShopCatalog } from '../src/domain/shop.ts';

class Rectangle {
  x:number;y:number;width:number;height:number;
  constructor(x:number,y:number,width:number,height:number) {this.x=x;this.y=y;this.width=width;this.height=height;}
  static Contains(area:Rectangle,x:number,y:number):boolean {return x>=area.x&&y>=area.y&&x<=area.x+area.width&&y<=area.y+area.height;}
}

// 只替换 Phaser 的绘制边界；角色创建、目标选择与交互分发都跑生产代码。
class Display extends EventEmitter {
  x:number;y:number;visible=true;active=true;alpha=1;width=0;height=0;
  list:Display[]=[];
  anims={timeScale:1,accumulator:0};
  input?:{enabled:boolean};
  constructor(x=0,y=0) {super();this.x=x;this.y=y;}
  setDepth() {return this;} setOrigin() {return this;} setBlendMode() {return this;} setScale() {return this;}
  setAlpha(value:number) {this.alpha=value;return this;} setVisible(value:boolean) {this.visible=value;return this;}
  setText() {return this;} setColor() {return this;}
  addAt(value:Display,index:number) {this.list.splice(index,0,value);return this;}
  add() {return this;}
  setInteractive() {this.input={enabled:true};return this;}
  disableInteractive() {if(this.input)this.input.enabled=false;return this;}
  play() {return this;} destroy() {this.active=false;this.removeAllListeners();}
}
const boundary=Symbol.for('inotia.world-interaction-test.phaser');
Object.defineProperty(globalThis,boundary,{value:{Rectangle},configurable:true});
const phaser=registerHooks({resolve(specifier,context,next) {
  return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(`
    const {Rectangle}=globalThis[Symbol.for('inotia.world-interaction-test.phaser')];
    export default {Geom:{Rectangle},BlendModes:{NORMAL:0,ADD:1,SCREEN:2,MULTIPLY:3},Scene:class{},Physics:{Arcade:{Body:class{}}}};
  `)}`}:next(specifier,context);
}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
phaser.deregister();

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8')) as T;
const world=read<WorldIndex>('content/world.json'),campaign=read<Campaign>('content/campaign.json');

/** 交互测试不检查角色画面；把静态图集图层换成动态图层，夹具就不依赖图集映射。 */
function dynamicWorld(source:WorldIndex):WorldIndex {
  const actors:WorldIndex['actors']={};
  for(const [id,actor] of Object.entries(source.actors)){
    const clips={...actor.clips};
    for(const name of Object.keys(clips) as (keyof typeof clips)[]){
      const clip=clips[name];
      if(!clip)continue;
      clips[name]={...clip,layers:clip.layers.map(layer=>({...layer,file:''}))};
    }
    actors[id]={...actor,clips};
  }
  return {...source,actors};
}
const items=read<ItemCatalog>('content/items.json'),stats=read<CharacterStatsCatalog>('content/character-stats.json');
const drops=read<DropCatalog>('content/drops.json'),shops=read<ShopCatalog>('content/shops.json');

interface Character {entity:EntityPlacement;actor:ActorDefinition;container:Display;marker:null}
interface SceneHooks {
  createActor(entity:EntityPlacement):Character;
  attackKey():void;
}

function session():Session {
  return new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items));
}

function mapOf(id:string):WorldMap {
  return read<WorldMap>(world.maps.find(reference=>reference.id===id)!.file);
}

function machine(map:WorldMap):EntityPlacement {
  return map.entities.find(entity=>world.actors[entity.actor]?.service==='fusion-machine')!;
}

function sword(map:WorldMap):EntityPlacement {
  return map.entities.find(entity=>world.actors[entity.actor]?.service==='legendary-sword')!;
}

function innkeeper(map:WorldMap):EntityPlacement {
  return map.entities.find(entity=>world.actors[entity.actor]?.service==='innkeeper')!;
}

function merchandiseDealer(map:WorldMap):EntityPlacement {
  return map.entities.find(entity=>entity.actor==='merchandise-dealer-4156e064')!;
}

/** 站在融合器正下方，面朝它按一次攻击键。 */
function pressAttack(mapId:string,current=new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items)),select=(map:WorldMap)=>machine(map),facing:Facing='north') {
  const map=mapOf(mapId),entity=select(map),calls:string[]=[],animations=new Set<string>();
  current.chests.enterMap(map.id);
  const combat={controlledVisual:undefined as {container:Display}|undefined,controlledMember:{level:100},
    facing,cannotAct:false,playerCannotAct:()=>false,hasHostileTarget:()=>false,
    attack:()=>calls.push('attack'),setPerformanceActive(){},syncChestEnemies(){}};
  const state={
    app:{world:dynamicWorld(world),items,session:current,campaign,locked:false,suspended:false,characterStats:stats,
      autoSave:()=>calls.push('autosave'),
      ui:{ready:true,controlLayoutEditing:false,showInstant:(message:string)=>calls.push(`instant:${message}`)},
      audio:{ui:(sound:string)=>calls.push(sound),effect:(sound:string)=>calls.push(`effect:${sound}`)},shops,
      openShop:(shopId:string)=>calls.push(`openShop:${shopId}`),
      director:{interact:(_entity:EntityPlacement,actor:ActorDefinition)=>{calls.push(`interact:${actor.id}`);return Promise.resolve(true);},
        visitInnkeeper:(actor:ActorDefinition,quote:{cost:number},rest:()=>void)=>{calls.push(`visitInnkeeper:${actor.id}:${quote.cost}`);rest();return Promise.resolve(true);}},
      openCrafting:(actorId:string)=>calls.push(`openCrafting:${actorId}`)},
    map,dropCatalog:drops,player:{container:new Display()},characters:[] as Character[],near:null as Character|null,combat,
    autoAttack:{engage(){}},performing:false,loadingWorld:false,active:true,chestFades:new Map(),
    sys:{isActive:()=>true},
    add:{container:(x:number,y:number)=>new Display(x,y),sprite:()=>new Display(),text:()=>new Display()},
    anims:{exists:(key:string)=>animations.has(key),create:({key}:{key:string})=>animations.add(key),generateFrameNumbers:()=>[]},
    movement:{register(){},setEnabled(){}},
    tweens:{add:()=>({paused:false,pause(){},resume(){}})},
    refreshCombatTarget(){},refreshLoadout(){},refreshState(){calls.push('refresh');},syncHud(){},checkpointStoryWorld(){calls.push('checkpoint');}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as SceneHooks;
  state.characters.push(scene.createActor({...entity}));
  state.player.container.x=entity.x;state.player.container.y=entity.y+16;
  scene.attackKey();
  return {calls,entity,combat};
}

test('an available fusion quest takes the interaction before the crafting panel',()=>{
  const {calls,entity}=pressAttack('shadow-hall');
  assert.deepEqual(calls,[`interact:${entity.actor}`]);
});

test('a ready fusion quest is handed in instead of opening the crafting panel',()=>{
  const current=session();
  assert.equal(current.accept('quest-353'),true);
  for(let count=0;count<5;count++)current.bag.add('paillette',1);
  current.refresh();
  assert.equal(current.status('quest-353'),'ready');
  const {calls}=pressAttack('shadow-hall',current);
  assert.deepEqual(calls,['interact:fusion-machine-3d13b5ee']);
});

test('an active fusion quest does not block the crafting panel',()=>{
  const current=session();
  assert.equal(current.accept('quest-353'),true);
  assert.equal(current.status('quest-353'),'active');
  const {calls}=pressAttack('shadow-hall',current);
  assert.deepEqual(calls,['openCrafting:fusion-machine-3d13b5ee']);
});

test('a fusion machine without any offer opens the crafting panel',()=>{
  const {calls,entity}=pressAttack('hall-of-afterlife-0780bd4c');
  assert.deepEqual(calls,[`openCrafting:${entity.actor}`]);
});

test('an ancient sword is consumed and saved when the hero does not meet the map level gate',()=>{
  const current=session(),mapId='underground-prison-guardpost-358b2781',before=current.bag.entries.length,original=Math.random;
  const values=[0,0.01,0.1,0,0,0];let index=0;Math.random=()=>values[index++]??0.5;
  try {
    const {calls,entity}=pressAttack(mapId,current,map=>sword(map));
    assert.equal(current.legendaryWeapons.isPulled(mapId,entity.id),true);
    assert.ok(calls.includes('instant:能力不足，无法获得武器。'));
    assert.ok(!calls.includes('effect:UI_Ground_sword'));
    assert.ok(calls.includes('autosave'));
    assert.ok(calls.includes('checkpoint'));
    assert.equal(current.bag.entries.length,before);
  } finally { Math.random=original; }
});

test('the innkeeper confirmation charges, restores and autosaves',()=>{
  const current=session();current.gainMoney(100);current.hero!.setHealth(1);current.hero!.setMana(1);
  const {calls}=pressAttack('kamuran-village-inn-29c0e2b1',current,map=>innkeeper(map));
  assert.ok(calls.some(call=>call.startsWith('visitInnkeeper:innkeeper-ad05fa66:1')));
  assert.ok(calls.includes('autosave'));
  assert.ok(calls.some(call=>call.startsWith('instant:已恢复全部的生命和魔法。')));
  assert.ok(calls.includes('checkpoint'));
  assert.equal(current.money,99);
  assert.equal(current.hero!.player.health,current.hero!.player.maxHealth);
  assert.equal(current.hero!.player.mana,current.hero!.player.maxMana);
});

test('a shop NPC without a greeting opens the shop instead of attacking',()=>{
  const {calls,entity}=pressAttack('steel-orc-village-57c67f8c',undefined,map=>merchandiseDealer(map));
  assert.equal(entity.actor,'merchandise-dealer-4156e064');
  assert.equal(world.actors[entity.actor].description,'');
  assert.deepEqual(calls,[`openShop:${entity.actor}`]);
});

test('a target behind the player still interacts and the character turns toward it',()=>{
  const {calls,entity,combat}=pressAttack('steel-orc-village-57c67f8c',undefined,map=>merchandiseDealer(map),'south');
  assert.equal(entity.actor,'merchandise-dealer-4156e064');
  assert.deepEqual(calls,[`openShop:${entity.actor}`],'背对目标也打开商店');
  assert.equal(combat.facing,'north','交互前转向目标');
});

test('a successful ancient sword pull grants a weapon and plays the sword sound',()=>{
  const current=session();current.hero!.addExperience(100000);
  const mapId='shadow-training-dungeon1-5e8c19b4',before=current.bag.entries.length,original=Math.random;
  const values=[0,0.01,0.1,0,0,0];let index=0;Math.random=()=>values[index++]??0.5;
  try {
    const {calls,entity}=pressAttack(mapId,current,map=>sword(map));
    assert.equal(current.legendaryWeapons.isPulled(mapId,entity.id),true);
    assert.ok(calls.includes('effect:UI_Ground_sword'));
    assert.ok(calls.includes('autosave'));
    assert.ok(current.bag.entries.length>before);
  } finally { Math.random=original; }
});

function revivalShortcut(fallenIds:string[]) {
  const revived:string[]=[],messages:string[]=[],entries=[
    {id:'scroll-1',item:'resurrection-scroll'},{id:'scroll-2',item:'resurrection-scroll'}];
  const fallen=new Set(fallenIds);
  const party={
    activeIds:['player','companion-1','companion-2'],
    livingIds:['player','companion-1','companion-2'].filter(id=>!fallen.has(id)),
    alive:(id:string)=>!fallen.has(id),
    revive:(id:string,item:string)=>{
      revived.push(`${id}:${item}`);fallen.delete(id);
      party.livingIds=party.activeIds.filter(id=>!fallen.has(id));
      const index=entries.findIndex(entry=>entry.id===item);if(index>=0)entries.splice(index,1);
    },
  };
  const state={
    sys:{isActive:()=>true},loadingWorld:false,
    app:{session:{bag:{entries},party},items:{items:{'resurrection-scroll':{name:'复活卷轴',use:{kind:'revive'}}}},
      ui:{ready:true,showInstant:(message:string)=>messages.push(message)},locked:false,suspended:false,director:{busy:false}},
    combat:{revive:(id:string,item:string)=>{party.revive(id,item);return {kind:'revive'};}},
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as {useShortcutItem(id:string):void};
  return {scene,revived,messages,entries};
}

test('a revival scroll on the shortcut bar revives fallen members in party order',()=>{
  const {scene,revived,messages,entries}=revivalShortcut(['companion-1','companion-2']);
  scene.useShortcutItem('resurrection-scroll');
  scene.useShortcutItem('resurrection-scroll');
  assert.deepEqual(revived,['companion-1:scroll-1','companion-2:scroll-2'],'按上阵顺序复活，每次消耗一张卷轴');
  assert.deepEqual(messages,[]);
  assert.equal(entries.length,0);
  scene.useShortcutItem('resurrection-scroll');
  assert.equal(revived.length,2,'没有卷轴时什么都不做');
});

test('a revival scroll with nobody fallen shows a message and keeps the scroll',()=>{
  const {scene,revived,messages,entries}=revivalShortcut([]);
  scene.useShortcutItem('resurrection-scroll');
  assert.deepEqual(revived,[]);
  assert.deepEqual(messages,['当前没有阵亡的出战队员']);
  assert.equal(entries.length,2,'没人倒下时不消耗卷轴');
});
