import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChestVisits, canReachChest, facesTarget, nearInteractable, nearInteractive, rollPlacement, SHOP_COUNTER_GAP } from '../src/domain/chests.ts';
import { rollChestLoot, parseDrops, type DropCatalog } from '../src/domain/drops.ts';
import { parseCharacterStats, parseMap } from '../src/application/content-validation.ts';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import type { WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';

const content=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}`,import.meta.url),'utf8'));
const drops=content('drops.json') as DropCatalog;
const stats=parseCharacterStats(content('character-stats.json'));
const world=content('world.json') as WorldIndex;
const campaign=content('campaign.json') as Campaign;
const map=content('maps/shadow-forest-west.json') as WorldMap;
const mimic=drops.chests.ordinary.spawn!.enemyId;
const empty=()=>({rewards:[],enemies:[]});

test('export covers 68 ordinary and 19 improved chests, with special boxes left to story rules',()=>{
  const counts:{ordinary:number;improved:number;boss:number}={ordinary:0,improved:0,boss:0};
  for(const reference of world.maps){
    const map=parseMap(content(reference.file.replace('content/','')));
    for(const entity of map.entities){
      const kind=world.actors[entity.actor].chest;
      if(kind){
        counts[kind]++;assert.ok(Number.isSafeInteger(map.lootLevel));
        // 记录里的 flip 位是朝向提示，只有 `MAP_LoadLayer` 直接创建的对象才照它设朝向；
        // 宝箱经 `MAP_nNPCItemLocation` 列表由 `MAP_ProduceNPCItem` 创建，保持默认朝向（findings 94）。
        assert.equal(entity.flip,false,`${reference.id} 的宝箱不该跟随记录的朝向位`);
      }
    }
  }
  assert.deepEqual(counts,{ordinary:68,improved:19,boss:0});
  for(const id of ['box-5f6f8808','old-box-1d5f38b4','treasure-box-5ea1dd1f','treasure-box-0b584b3d','treasure-box-aa819e7d'])
    assert.equal(world.actors[id].chest,undefined);
  assert.equal(map.lootLevel,1);
  assert.equal(content('audio.json').ui.chestOpen,'Object_Treasure_Open');
  assert.throws(()=>parseMap({...map,lootLevel:-1}),/lootLevel/);
});

test('story-placed BOSS treasure chests use the improved three-pass profile',()=>{
  const actor='story-boss-treasure-chest-59456ff6';
  assert.equal(world.actors[actor].chest,'improved','NPC 212 在原版链到开箱功能 37');
  const placements:{script:string;map:string}[]=[];
  for(const [script,definition] of Object.entries(campaign.scripts))
    for(const node of definition.nodes)
      for(const command of node.commands){
        if(command.type!=='world'||command.command.kind!=='place')continue;
        const entity=command.command.entity;
        if(entity.characterId!=='npc-212')continue;
        assert.equal(world.actors[entity.actor].chest,'improved',`${script} 摆放的 BOSS 宝箱要按宝箱处理`);
        assert.equal(command.command.scope,undefined,`${script} 的 BOSS 宝箱要常驻，离开地图后不能消失`);
        assert.ok(Number.isSafeInteger(content(`maps/${entity.map}.json`).lootLevel),`${entity.map} 缺少掉落等级`);
        placements.push({script,map:entity.map});
      }
  assert.equal(placements.length,13,'原版事件里的 BOSS 宝箱摆放数');
  assert.deepEqual(placements.map(value=>value.script),[...new Set(placements.map(value=>value.script))],'每个脚本只摆放一次');
});

test('native chest rules retain independent one-pass and three-pass drops and mimic selection',()=>{
  const rules=drops.chests;
  assert.deepEqual(rules.ordinary.chances,{money:9000,equipment:1200,consumable:1800,upgrade:300,crafting:2000,misc:400,unique:0,fixed:0});
  assert.deepEqual(rules.improved.chances,{money:9000,equipment:3000,consumable:3600,upgrade:3200,crafting:3000,misc:1200,unique:0,fixed:0});
  const ordinary=rollChestLoot(drops,stats,'ordinary',30,30,()=>0);
  const improved=rollChestLoot(drops,stats,'improved',30,30,()=>0);
  // 普通箱与优质箱的品质下限不同，品级快照不能直接逐项比较；这里核对三次重复的奖励身份。
  const identity=(result:typeof ordinary)=>result.rewards.map(reward=>reward.kind==='money'
    ?{kind:reward.kind,amount:reward.amount}:{kind:reward.kind,item:reward.item});
  assert.deepEqual(identity(improved),[...identity(ordinary),...identity(ordinary),...identity(ordinary)]);
  assert.deepEqual(ordinary.enemies,[mimic]);
  assert.deepEqual(improved.enemies,[]);
  assert.deepEqual(rollChestLoot(drops,stats,'ordinary',30,30,()=>.9999),empty());
  for(const level of [0,-1])assert.throws(()=>rollChestLoot(drops,stats,'ordinary',level,1),/掉落等级/);
});

test('chest rare chance uses map level, caps hero level at the chest level, and keeps the strict random boundary',()=>{
  const data=structuredClone(drops);
  const rule=data.chests.ordinary;
  for(const slot of Object.keys(rule.chances) as (keyof typeof rule.chances)[])rule.chances[slot]=0;
  delete rule.spawn;
  data.equipment.unique=[{item:'test-rare',dropLevel:1}];
  // floor(2000/(100+100))=10; at equal levels random integer 9 passes and 10 fails.
  assert.equal(rollChestLoot(data,stats,'ordinary',100,100,()=>8/9999).rewards.length,1);
  assert.equal(rollChestLoot(data,stats,'ordinary',100,100,()=>9/9999).rewards.length,0);
  // 体验版：满级玩家开 1 级宝箱仍按宝箱等级结算，不会被玩家等级压成空箱。
  assert.equal(rollChestLoot(data,stats,'ordinary',1,100,()=>0).rewards.length,1);
});

test('drop parser rejects missing chest profiles and invalid mimic references',()=>{
  const items=content('items.json'),ids=content('battle.json').enemies.map((enemy:{id:string})=>enemy.id);
  assert.equal(parseDrops(drops,items,ids),drops);
  const invalid=structuredClone(drops);invalid.chests.ordinary.spawn!.enemyId='missing';
  assert.throws(()=>parseDrops(invalid,items,ids),/宝箱掉落规则/);
  assert.throws(()=>parseDrops({...drops,chests:{}},items,ids),/宝箱掉落规则/);
});

test('opening is claimed before rolling; repeated and reentrant clicks cannot pay twice',()=>{
  const chests=new ChestVisits();chests.enterMap('forest');let rolls=0;
  const result=chests.open('forest','box',{x:10,y:20},()=>{
    rolls++;
    assert.equal(chests.open('forest','box',{x:10,y:20},()=>{assert.fail('reentrant roll');}),undefined);
    return {rewards:[{kind:'money' as const,amount:10}],enemies:[mimic]};
  });
  assert.equal(result?.rewards.length,1);
  assert.equal(chests.open('forest','box',{x:10,y:20},()=>{assert.fail('repeat roll');}),undefined);
  assert.equal(rolls,1);assert.equal(chests.spawns.length,1);
  assert.deepEqual(chests.spawns[0],{id:'chest:1:forest:box:0',enemyId:mimic,x:10,y:20,respawn:false});
});

test('same-map rebuild preserves opened state; another map and returning create fresh visits',()=>{
  const chests=new ChestVisits();chests.enterMap('forest');chests.open('forest','box',{x:0,y:0},empty);
  chests.enterMap('forest');assert.equal(chests.isOpened('forest','box'),true);
  assert.equal(chests.open('cave','box',{x:0,y:0},empty),undefined);
  chests.enterMap('cave');assert.equal(chests.isOpened('cave','box'),false);
  assert.ok(chests.open('cave','box',{x:0,y:0},empty));
  chests.enterMap('forest');assert.ok(chests.open('forest','box',{x:0,y:0},empty));
  assert.equal(new ChestVisits().isOpened('forest','box'),false);
});

test('a story-placed one-time chest stays consumed after leaving and returning',()=>{
  const chests=new ChestVisits();
  chests.enterMap('boss-room');
  assert.ok(chests.open('boss-room','story-object-1-2',{x:0,y:0},empty,true));
  assert.equal(chests.isOpened('boss-room','story-object-1-2',true),true);
  chests.enterMap('village');chests.enterMap('boss-room');
  assert.equal(chests.isOpened('boss-room','story-object-1-2',true),true,'回来时仍是已开启');
  assert.equal(chests.open('boss-room','story-object-1-2',{x:0,y:0},
    ()=>{throw new Error('已开启的一次性宝箱不能再掷奖励')},true),undefined);
  // 普通地图宝箱仍按每次访问重掷。
  chests.enterMap('village');chests.enterMap('forest');
  chests.open('forest','box',{x:0,y:0},empty);
  chests.enterMap('village');chests.enterMap('forest');
  assert.equal(chests.isOpened('forest','box'),false);
});

test('failed reward preparation releases the claim without spawning a monster',()=>{
  const chests=new ChestVisits();chests.enterMap('forest');
  assert.throws(()=>chests.open('forest','box',{x:0,y:0},()=>{throw new Error('invalid loot');}),/invalid loot/);
  assert.equal(chests.isOpened('forest','box'),false);assert.equal(chests.spawns.length,0);
  assert.ok(chests.open('forest','box',{x:0,y:0},empty));
});

test('mimic survives scene rebuild with vitals and never joins timed respawns',()=>{
  const session=new Session(campaign),roster=new WorldEnemyRoster(session,map,[],1);
  session.chests.open(map.id,'box',{x:504,y:104},()=>({rewards:[],enemies:[mimic]}));
  const [spawn]=session.chests.spawns;
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),[spawn.id]);
  assert.equal(roster.source(spawn.id)?.respawn,false);
  session.setEnemyVitals(spawn.id,12,0);
  assert.equal(new WorldEnemyRoster(session,map,[],1).enemies.find(enemy=>enemy.key===spawn.id)?.health,12);
  session.enemyDefeated(spawn);assert.ok(roster.refresh().removed.includes(spawn.id));
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS*10);
  assert.equal(new WorldEnemyRoster(session,map,[],1).enemies.some(enemy=>enemy.key===spawn.id),false);
  session.enterMap('elsewhere');assert.deepEqual(session.enemyVitals(spawn.id),{});
  new WorldEnemyRoster(session,map,[],1);
  session.chests.open(map.id,'box',{x:504,y:104},()=>({rewards:[],enemies:[mimic]}));
  assert.notEqual(session.chests.spawns[0].id,spawn.id);
});

test('chest placement rerolls each entry: ordinary passes one gate, improved passes two or downgrades',()=>{
  // 注入的随机源按顺序给出点数：rollPlacement 里的 dice() = floor(random()*99)+1。
  // 取每个点数区间的中点，避免 (n-1)/99 再乘 99 时的浮点误差把 60 落成 59。
  const dice=(...values:number[])=>{let index=0;return()=>((values[Math.min(index++,values.length-1)]!-.5)/99);};
  const ordinary={id:'box',actor:'treasure-box-a0caef88',x:0,y:0,appear:{atMost:29}};
  assert.equal(rollPlacement(ordinary,dice(30)),undefined,'普通宝箱掷 30 点不出现');
  assert.ok(rollPlacement(ordinary,dice(29)),'普通宝箱掷 29 点出现');
  const improved={id:'box',actor:'improved-treasure-box-85467c1c',x:0,y:0,appear:{atMost:29},
    downgrade:{atLeast:60,actor:'treasure-box-a0caef88'}};
  assert.equal(rollPlacement(improved,dice(30)),undefined,'第一道关没过就不出现');
  assert.equal(rollPlacement(improved,dice(29,60))?.actor,'improved-treasure-box-85467c1c','两道关都过才是优质宝箱');
  assert.equal(rollPlacement(improved,dice(29,59))?.actor,'treasure-box-a0caef88','第二道关没过降级成普通宝箱');
  // 没有规则的摆放点（火把、旧箱子这类装饰）原样保留。
  const plain={id:'torch',actor:'torch-45eb4a23',x:0,y:0};
  assert.equal(rollPlacement(plain,dice(99)),plain);
});

test('chest interaction follows the native near-object, rect-distance and facing rules',()=>{
  // 身边对象：脚底坐标的曼哈顿距离不超过 24 px（PLAYER_DoCheckNearNPC 0x1be0b0）。
  assert.equal(nearInteractable({x:0,y:0},{x:24,y:0}),true);
  assert.equal(nearInteractable({x:0,y:0},{x:16,y:8}),true);
  assert.equal(nearInteractable({x:0,y:0},{x:25,y:0}),false);
  // 可动作距离：两个 16×16 脚底矩形的间隙和 ÷ 8 不超过 6（CHAR_GetDistance 0x1767ac）。
  assert.equal(canReachChest({x:0,y:0},{x:64,y:0}),true);
  assert.equal(canReachChest({x:0,y:0},{x:65,y:0}),false);
  assert.equal(canReachChest({x:0,y:0},{x:48,y:32}),true);
  assert.equal(canReachChest({x:0,y:0},{x:48,y:33}),false);
  // 自身带实体范围的机关：按真实碰撞盒的贴边间隙兜底（普通目标 1 格，商店柜台 4 格）。
  const body={x:-8,y:-8,width:16,height:16};
  assert.equal(nearInteractive({x:0,y:0},{x:32,y:0},body),false,'16×16 目标在 2 格外不再选中');
  assert.equal(nearInteractive({x:0,y:0},{x:32,y:0},body,false,SHOP_COUNTER_GAP),true,'商店上限 4 格');
  assert.equal(nearInteractive({x:0,y:0},{x:65,y:0},body,false,SHOP_COUNTER_GAP),false);
  // 48×32 的路障贴着右边站：锚点曼哈顿 32，盒子边缘间隙 0。
  const barricade={x:-24,y:-16,width:48,height:32};
  assert.equal(nearInteractive({x:0,y:0},{x:32,y:0},barricade),true);
  // 32×64 的钢门：玩家被挡在锚点右侧 28 px，盒子边缘间隙 4。
  const steelDoor={x:-16,y:-32,width:32,height:64};
  assert.equal(nearInteractive({x:0,y:0},{x:28,y:0},steelDoor),true);
  // 16×24 的净化石：玩家站在下方 1 格时贴边可交互，下方 2 格（间隙 16）不再选中。
  const purityStone={x:-8,y:-16,width:16,height:24};
  assert.equal(nearInteractive({x:0,y:0},{x:0,y:-16},purityStone),true);
  assert.equal(nearInteractive({x:0,y:0},{x:0,y:-32},purityStone),false);
  // 商店隔柜台：16×16 的商人在 48 px 外，间隙 32，用商店上限能选中；普通上限不行。
  assert.equal(nearInteractive({x:0,y:0},{x:0,y:48},body,false,SHOP_COUNTER_GAP),true);
  assert.equal(nearInteractive({x:0,y:0},{x:0,y:48},body),false);
  // 朝向：目标落在哪一轴就得朝哪一边（GAMESTATE_PressKeyPlay 0x12f6f8）。
  assert.equal(facesTarget({x:0,y:0},'east',{x:20,y:4}),true);
  assert.equal(facesTarget({x:0,y:0},'north',{x:20,y:4}),false);
  assert.equal(facesTarget({x:0,y:0},'south',{x:4,y:20}),true);
  assert.equal(facesTarget({x:0,y:0},'west',{x:4,y:20}),false);
});


test('every real chest has a positive effective level and zero-level maps fall back',()=>{
  const zeroMaps:string[]=[];
  for(const reference of world.maps){
    const map=content(reference.file.replace('content/','')) as WorldMap;
    const chests=map.entities.filter(entity=>world.actors[entity.actor]?.chest);
    if(!chests.length)continue;
    assert.ok(Number.isSafeInteger(map.chestLevel)&&map.chestLevel!>=1,`${reference.id} 的宝箱等级无效`);
    if(map.lootLevel===0)zeroMaps.push(reference.id);
    for(const entity of chests){
      const kind=world.actors[entity.actor].chest!;
      const rolled=rollChestLoot(drops,stats,kind,map.chestLevel!,100,()=>0);
      assert.ok(rolled.rewards.length>0,`${reference.id} 的宝箱在零随机值下应至少产出金币`);
    }
  }
  assert.equal(zeroMaps.length,6,'6 张 lootLevel=0 的地图由邻居等级回退');
});
