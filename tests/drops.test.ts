import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDrops, rollEnemyLoot, rollQuestDrops, type DropCatalog, type EnemyDropRule } from '../src/domain/drops.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { GroundLootStore } from '../src/domain/ground-loot.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { Bag } from '../src/domain/bag.ts';

const items={items:{scale:{category:'material',level:1},cloak:{category:'equipment',level:20},amulet:{category:'equipment',level:25},potion:{category:'consumable',level:1}}} as unknown as ItemCatalog;
/** 掉落规则用例不生成装备实例：属性目录里没有任何装备品级快照。 */
const stats={equipment:{}} as unknown as CharacterStatsCatalog;
const enemyDrops=(data:DropCatalog,enemyId:string,playerLevel:number,random:()=>number)=>
  rollEnemyLoot(data,stats,enemyId,playerLevel,playerLevel,random).rewards;
const chances=()=>({money:0,equipment:0,consumable:0,upgrade:0,crafting:0,misc:0,unique:0,fixed:0});
const chests=():DropCatalog['chests']=>({
  ordinary:{pool:'ordinary',rolls:1,chances:chances(),fixed:[],uniqueChance:{numerator:0,levelOffset:100}},
  improved:{pool:'ordinary',rolls:3,chances:chances(),fixed:[],uniqueChance:{numerator:0,levelOffset:100}}
});
const catalog=(rule:EnemyDropRule):DropCatalog=>({version:2,questItems:{},chests:chests(),enemies:{enemy:rule},equipment:{weapon:[{item:'cloak',dropLevel:20}],armor:[{item:'amulet',dropLevel:25}],special:[{item:'potion',dropLevel:1}],unique:[{item:'amulet',dropLevel:25}],epic:[]},pools:{ordinary:{consumable:[{weight:5000,tiers:[{item:'potion',level:1}]},{weight:1000,item:null}]}}});
const random=(...values:number[])=>{let index=0;return()=>values[index++]??0;};

test('fixed rewards and coin amount use independent death rolls',()=>{
  const rule:EnemyDropRule={level:30,pool:'ordinary',rolls:1,chances:{...chances(),money:9999,fixed:9999},
    fixed:[{item:'scale',weight:400},{item:'cloak',weight:600}]};
  assert.deepEqual(enemyDrops(catalog(rule),'enemy',30,random(0,.5,0,.75)),[
    {kind:'money',amount:210},{kind:'item',item:'cloak',quantity:1}
  ]);
});

test('a successful random slot can select a level tier, an empty slot, or empty range',()=>{
  const rule:EnemyDropRule={level:20,pool:'ordinary',rolls:1,chances:{...chances(),consumable:9999},fixed:[]};
  const data=catalog(rule);
  assert.deepEqual(enemyDrops(data,'enemy',20,random(0,0)),[{kind:'item',item:'potion',quantity:1}]);
  assert.deepEqual(enemyDrops(data,'enemy',20,random(0,.55)),[]);
  assert.deepEqual(enemyDrops(data,'enemy',20,random(0,.9)),[]);
  assert.equal(parseDrops(data,items,['enemy']).enemies.enemy.pool,'ordinary');
});

test('fixed-only enemies settle three independent drop passes',()=>{
  const rule:EnemyDropRule={level:30,pool:'fixed-only',rolls:3,chances:{...chances(),fixed:9999},fixed:[{item:'scale',weight:1000}]};
  const data:DropCatalog={version:2,questItems:{},chests:chests(),enemies:{enemy:rule},equipment:{weapon:[],armor:[],special:[],unique:[],epic:[]},pools:{'fixed-only':{}}};
  assert.equal(enemyDrops(data,'enemy',30,random(0,0,0,0,0,0)).length,3);
});

test('native no-normal-drop flag suppresses ordinary loot without touching quest drops',()=>{
  const rule:EnemyDropRule={level:30,pool:'ordinary',rolls:1,noNormalDrops:true,chances:{...chances(),money:9999},fixed:[]};
  const data:DropCatalog={...catalog(rule),questItems:{enemy:[{item:'scale',threshold:99}]}};
  assert.deepEqual(enemyDrops(data,'enemy',30,()=>0),[]);
  assert.deepEqual(rollQuestDrops(data,'enemy',[[{item:'scale',quantity:1,owned:0}]],()=>0),
    [{kind:'item',item:'scale',quantity:1}],'任务掉落仍在 CHARSYSTEM_Die 的闸门之后执行');
  assert.throws(()=>parseDrops({...data,enemies:{enemy:{...rule,noNormalDrops:1 as unknown as boolean}}},items,['enemy']),/无掉落标志/);
});

test('published no-normal-drop enemies match the native MONDATABASE bit4 set',()=>{
  const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
  const drops=read<DropCatalog>('drops');
  const flagged=Object.entries(drops.enemies).filter(([,rule])=>rule.noNormalDrops).map(([id])=>id).sort();
  assert.deepEqual(flagged,[
    'enemy-alexander-1','enemy-alexander-2','enemy-baron-borgia-1','enemy-captain-of-arnen-chasers-1',
    'enemy-chasers-scout-captain-1','enemy-contaminated-berkel-priest-1','enemy-cornette-1',
    'enemy-dark-offerings-1','enemy-dark-priest-1','enemy-doppelganger-1','enemy-earl-grafton-1',
    'enemy-head-goblin-yirzuch-1','enemy-principle-guardian-1','enemy-redhood-bandits-boss-1',
    'enemy-shin-1','enemy-summoned-cursed-creature-1','enemy-summoned-pawn-of-hell-1','enemy-tindalrose-1',
  ].sort());
  assert.deepEqual(enemyDrops(drops,'enemy-earl-grafton-1',3,()=>0),[],'伯爵原版不走普通掉落');
  assert.equal(drops.enemies['enemy-berkel-soldier-2'].noNormalDrops,undefined);
  assert.notDeepEqual(enemyDrops(drops,'enemy-berkel-soldier-2',1,()=>0),[])
});

test('equipment levels, class proportions and unique armor follow separate draws',()=>{
  const data=catalog({level:30,pool:'ordinary',rolls:1,chances:{...chances(),equipment:9999,unique:9999},fixed:[]});
  data.equipment.unique=[{item:'scale',dropLevel:20}];
  assert.throws(()=>parseDrops(data,items,['enemy']),/装备掉落池无效/);
  data.equipment.unique=[{item:'amulet',dropLevel:25}];
  assert.deepEqual(enemyDrops(data,'enemy',30,random(0,.5,.5,0,0,0,0)),[
    {kind:'item',item:'cloak',quantity:1},{kind:'item',item:'amulet',quantity:1}
  ]);
  assert.deepEqual(enemyDrops(data,'enemy',30,random(0,.75,.75,.3,0,0,0)),[
    {kind:'item',item:'amulet',quantity:1},{kind:'item',item:'amulet',quantity:1}
  ]);
  const early=catalog({level:1,pool:'ordinary',rolls:1,chances:{...chances(),equipment:9999},fixed:[]});
  assert.deepEqual(enemyDrops(early,'enemy',1,random(0,0,0,.8,0)),[{kind:'item',item:'potion',quantity:1}]);
});

test('ground loot appears at the death position and is immediately collectible in its map',()=>{
  const ground=new GroundLootStore();
  const rewards=[{kind:'item',item:'scale',quantity:1},{kind:'money',amount:4}] as const;
  const drops=ground.add('cave',20,30,rewards);
  assert.deepEqual(drops.map(({x,y})=>({x,y})),[{x:20,y:30},{x:20,y:30}]);
  assert.equal(ground.forMap('forest').length,0);
  const received:string[]=[];
  assert.deepEqual(ground.collectNearby('forest',20,30,()=>{}),[]);
  assert.deepEqual(ground.collectNearby('cave',20,30,reward=>received.push(reward.kind)),drops);
  assert.deepEqual(received,['item','money']);
  assert.equal(ground.forMap('cave').length,0);
  assert.deepEqual(ground.collectNearby('cave',20,30,()=>assert.fail('double pickup')),[]);
});

test('ground pickup uses the original twelve-pixel square and preserves insertion order',()=>{
  const ground=new GroundLootStore(),reward={kind:'money',amount:1} as const;
  const [corner]=ground.add('cave',12,12,[reward]);
  const [outsideX]=ground.add('cave',13,0,[reward]);
  const [near]=ground.add('cave',1,1,[reward]);
  const [outsideY]=ground.add('cave',0,-13,[reward]);
  assert.deepEqual(ground.collectNearby('cave',0,0,()=>{}),[corner,near]);
  assert.deepEqual(ground.forMap('cave'),[outsideX,outsideY]);
});

test('failed collection retains the drop and its prepared equipment values',()=>{
  const ground=new GroundLootStore();
  const instance={id:'prepared',item:'cloak',quantity:1,enhancement:4,gems:[]};
  const [drop]=ground.add('cave',20,30,[{kind:'item',item:'cloak',quantity:1,instance}]);
  instance.enhancement=9;
  assert.throws(()=>ground.collectNearby('cave',20,30,()=>{throw new Error('bag full');}),/bag full/);
  assert.deepEqual(ground.forMap('cave'),[drop]);
  ground.collectNearby('cave',20,30,reward=>{
    assert.equal(reward.kind,'item');
    if(reward.kind==='item')assert.equal(reward.instance?.enhancement,4);
  });
});

test('prepared equipment keeps its generated values after pickup',()=>{
  const catalog={...items,items:{cloak:{...items.items.cloak,stackable:false}}} as ItemCatalog;
  const bag=new Bag(()=>{},catalog,'','none',{
    initialize:entry=>{entry.enhancement=4;},equipProblem:()=>undefined,targetProblem:()=>undefined,applyUse:()=>{}
  });
  const prepared=bag.prepareDrop('cloak');
  bag.receiveDrop(prepared);
  assert.equal(bag.entries[0].enhancement,4);
  assert.notEqual(bag.entries[0].id,prepared.id);
});
