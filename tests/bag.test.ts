import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bag, verifyBagState } from '../src/domain/bag.ts';
import { IMPLEMENTED_CONSUMABLES, ITEM_USES, SKILL_POINT_ITEM, USE_NOT_IMPLEMENTED, unimplementedItemUse, type ItemDefinition } from '../src/domain/items.ts';
import { costumeRecipe } from '../src/domain/wardrobe.ts';
import { parseItemCatalog, parseWardrobe, validateWardrobe, parseCampaign } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';
import { organizedInventory, pouchFor } from '../src/domain/inventory.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseItemCatalog(read('items')), wardrobe=parseWardrobe(read('wardrobe'));
const create=(classId='dark-knight',changed=()=>{},initial:readonly string[]=['healing-potion-s'])=>{
  let ready=false;const bag=new Bag(()=>{if(ready)changed();},catalog,classId);
  for(const item of initial)bag.add(item);
  for(const [slot,item] of Object.entries(catalog.startingEquipment[classId]))bag.addEquipped(item!,slot as import('../src/domain/items.ts').EquipmentSlot,'player');
  ready=true;return bag;
};
/** 每个场景只准备要用的物品，目录检索不等于把整个目录塞进背包。 */
const prepareItem=(bag:Bag,predicate:(item:ItemDefinition,id:string)=>boolean)=>{
  const existing=bag.entries.find(entry=>predicate(catalog.items[entry.item],entry.item));
  if(existing)return existing;
  const selected=Object.entries(catalog.items).find(([id,item])=>!item.pickup&&predicate(item,id));
  assert.ok(selected,'目录里应存在此场景需要的物品');bag.add(selected[0]);
  return bag.entries.find(entry=>entry.item===selected[0])!;
};
/** 按分类取若干件目录里的物品标识，用来搭小背包。 */
const pick=(category:string,count:number)=>Object.entries(catalog.items)
  .filter(([,item])=>item.category===category&&!item.pickup).slice(0,count).map(([id])=>id);
/** 按分类袋取少量物品，供落格、整理与穿戴场景使用。 */
const pouchItems=(pouch:ReturnType<typeof pouchFor>,count:number)=>Object.entries(catalog.items)
  .filter(([,item])=>pouchFor(item)===pouch&&!item.pickup).slice(0,count).map(([id])=>id);
const weapons=(count:number)=>pouchItems('weapon',count);

test('complete physical catalogue has every use flow and isolated starting equipment',()=>{
  assert.equal(Object.keys(catalog.items).length,1004);
  assert.deepEqual(new Set(Object.values(catalog.items).flatMap(d=>d.use?[d.use.kind]:[])),new Set(ITEM_USES));
  const physical=Object.entries(catalog.items).filter(([,item])=>!item.pickup);
  assert.equal(physical.length,1003);
  for(const [item] of physical){
    const bag=new Bag(()=>{},catalog);bag.add(item);
    assert.equal(bag.entries.length,1,item);assert.equal(bag.entries[0].item,item);
    assert.equal(bag.entries[0].quantity,1,item);bag.verifyConsistency();
  }
  for(const classId of Object.keys(catalog.startingEquipment)){
    const bag=create(classId);
    assert.deepEqual(bag.equipmentItems(),catalog.startingEquipment[classId]);
    for(const id of Object.values(bag.equipment))assert.ok(!bag.entries.some(entry=>entry.id===id));
  }
  assert.ok(!Object.values(catalog.items).some(d=>d.typeName==='InApp'||d.kind==='in-app'));
});

test('equipment swaps are atomic, obey class and hand restrictions, and ignore character level',()=>{
  let updates=0;const bag=create('warrior',()=>updates++);
  const twoHanded=prepareItem(bag,d=>!!d.equipment?.twoHanded&&d.equipment.classes.includes('warrior')&&!d.equipment.locked&&d.level>90);
  const oneHanded=prepareItem(bag,d=>!!d.equipment?.dualWield&&!d.equipment.locked);
  const old=bag.equipment, before=bag.entries.length;
  bag.planEquip(twoHanded.id,'main-hand');assert.deepEqual(bag.equipment,old);assert.equal(updates,0);
  bag.equip(twoHanded.id,'main-hand');assert.equal(bag.equipment['off-hand'],undefined);assert.equal(updates,1);
  assert.throws(()=>bag.equip(oneHanded.id,'off-hand'),/单手/);assert.equal(updates,1);
  bag.equip(oneHanded.id,'main-hand');
  const second=prepareItem(bag,d=>!!d.equipment?.dualWield&&!d.equipment.locked);bag.equip(second.id,'off-hand');
  assert.equal(bag.equipment['off-hand'],second.id);
  bag.unequip('main-hand');assert.equal(bag.equipment['off-hand'],undefined);
  assert.throws(()=>bag.equip(second.id,'off-hand'),/单手/);
  assert.ok(bag.entries.length>=before);
  const wrong=prepareItem(bag,d=>!!d.equipment&&!d.equipment.classes.includes('warrior'));
  assert.deepEqual(bag.slotsFor(wrong.id),[]);
  assert.deepEqual(bag.slotsFor(prepareItem(bag,d=>!!d.equipment?.locked).id),[]);
  const ring=prepareItem(bag,d=>d.equipment?.slot==='ring'&&!d.equipment.locked);
  bag.equip(ring.id,'accessory');assert.equal(bag.equipment.accessory,ring.id);
});

test('equipProblem answers like planEquip and never changes the bag',()=>{
  let updates=0;const bag=create('warrior',()=>updates++),equipped=JSON.stringify(bag.equipment);
  const oneHanded=prepareItem(bag,d=>!!d.equipment?.dualWield&&!d.equipment.locked);
  // 副手在没有单手主手时被拒；同一件放到主手没有问题。
  assert.equal(bag.equipProblem(oneHanded.id,'off-hand'),'请先装备一件单手主武器');
  assert.equal(bag.equipProblem(oneHanded.id,'main-hand'),undefined);
  // 槽位不在该件的可装备位置时，与 planEquip 用同一条消息。
  const twoHanded=prepareItem(bag,d=>!!d.equipment?.twoHanded&&!d.equipment.locked);
  assert.equal(bag.equipProblem(twoHanded.id,'off-hand'),'该物品不能装备在此位置');
  // 每件装备使用独立背包，逐件逐槽比较两种判定，保持完整目录覆盖。
  let checked=0;
  for(const [item,definition] of Object.entries(catalog.items)){
    if(!definition.equipment||definition.pickup)continue;
    const candidate=create('warrior',()=>updates++,[]);candidate.add(item);
    const entry=candidate.entries[0],before=candidate.captureState();
    for(const slot of candidate.slotsFor(entry.id)){
      let threw=false;try{candidate.planEquip(entry.id,slot);}catch{threw=true;}
      assert.equal(threw,candidate.equipProblem(entry.id,slot)!==undefined,`${entry.item} → ${slot}`);
      checked++;
    }
    assert.deepEqual(candidate.captureState(),before,'只读判定不改变物品、格位或穿戴');
  }
  assert.ok(checked>100,`实际比对了 ${checked} 组`);
  assert.equal(updates,0,'只读判定不触发状态更新');
  assert.equal(JSON.stringify(bag.equipment),equipped,'只读判定不改变穿戴');
});

test('all eligible equipment has complete poses, including shield, unarmed and dual wield',()=>{
  validateWardrobe(wardrobe,catalog);
  for(const classId of Object.keys(catalog.startingEquipment)){
    for(const [item,definition] of Object.entries(catalog.items)){
      if(!definition.equipment||definition.pickup)continue;
      const bag=create(classId,()=>{},[]);bag.add(item);
      const entry=bag.entries[0];
      for(const slot of bag.slotsFor(entry.id)){
        let next;try{next=bag.planEquip(entry.id,slot);}catch{continue;}
        const recipe=costumeRecipe(wardrobe,catalog,bag.equipmentItems(next));
        for(const action of ['idle','walk','attack'])for(const direction of ['north','south','east','west'])
          assert.ok(recipe.poses[`${action}-${direction}` as keyof typeof recipe.poses],`${entry.item}: ${action}-${direction}`);
      }
    }
  }
  assert.ok(costumeRecipe(wardrobe,catalog,{}).poses['walk-south']);
});

test('enhancement and sockets belong to each instance; bad targets never consume items',()=>{
  let changes=0;const bag=create('dark-knight',()=>changes++);
  const source=prepareItem(bag,d=>d.use?.kind==='enchant'&&d.use.target==='weapon'&&!d.use.maxLevel&&!d.use.requiresEnhanced);
  const target=bag.equipment['main-hand']!;
  const wrong=prepareItem(bag,d=>d.category==='material');const initial=bag.get(source.id);
  assert.throws(()=>bag.use(source.id,wrong.id),/装备/);assert.deepEqual(bag.get(source.id),initial);assert.equal(changes,0);
  bag.use(source.id,target);assert.equal(bag.get(target)!.enhancement,1);assert.equal(changes,1);
  assert.equal(bag.get(source.id),undefined);assert.throws(()=>bag.use(source.id,target));
  const item=bag.get(target)!.item;bag.add(item);
  const duplicate=bag.entries.find(e=>e.item===item)!;assert.equal(duplicate.enhancement,0);
  const gem=prepareItem(bag,d=>d.use?.kind==='socket');bag.add(gem.item,3);
  for(let i=0;i<3;i++)bag.use(bag.entries.find(e=>e.item===gem.item)!.id,target);
  const remaining=bag.entries.find(e=>e.item===gem.item)!;
  assert.throws(()=>bag.use(remaining.id,target),/宝石孔/);assert.equal(bag.count(gem.item),1);
  const copy=bag.get(target)!;copy.gems.length=0;assert.equal(bag.get(target)!.gems.length,3);
  const cleanse=prepareItem(bag,d=>d.use?.kind==='purify');assert.equal(bag.canApply(cleanse.id,target),false);
  assert.throws(()=>bag.use(cleanse.id,target),/装备/);
  assert.equal(bag.get(target)!.enhancement,1);assert.equal(bag.get(target)!.gems.length,3);
  assert.equal(bag.get(duplicate.id)!.gems.length,0);
});

test('packs, boxes, sealed books and recipes retain their actual rewards',()=>{
  const bag=create();
  const pack=prepareItem(bag,d=>d.use?.kind==='pack'),rewards=catalog.items[pack.item].use!.rewards!;
  const counts=bag.counts;bag.use(pack.id);
  for(const reward of rewards)assert.equal(bag.count(reward.item),(counts.get(reward.item)??0)+reward.quantity);
  const box=prepareItem(bag,d=>d.use?.kind==='box');
  assert.throws(()=>bag.use(box.id,undefined,undefined,()=>1),/随机/);assert.ok(bag.get(box.id));
  const result=bag.use(box.id,undefined,undefined,()=>0);
  assert.deepEqual(result.rewards,[catalog.items[box.item].use!.rewards![0]]);
  const sealed=prepareItem(bag,d=>d.use?.kind==='unseal'&&d.use.classId==='dark-knight');
  const bookResult=bag.use(sealed.id,undefined,undefined,()=>0);
  const book=bag.entries.find(e=>e.skill===bookResult.skill)!;
  bag.use(book.id);assert.equal(bag.lastResult!.skill,bookResult.skill);
  const foreign=prepareItem(bag,d=>d.use?.kind==='unseal'&&d.use.classId==='ranger');
  const foreignSkill=bag.use(foreign.id,undefined,undefined,()=>0).skill;
  const foreignBook=bag.entries.find(e=>e.skill===foreignSkill)!;
  assert.throws(()=>bag.use(foreignBook.id),/本职业/);assert.ok(bag.get(foreignBook.id));
  const recipe=prepareItem(bag,d=>d.use?.kind==='recipe'),learned=bag.use(recipe.id,undefined,undefined,()=>0).recipe!;
  assert.deepEqual(bag.learnedRecipes,[learned]);assert.ok(catalog.recipes[learned].materials.length);
});

test('an inconsistent bag state is refused at both boundaries and by the explicit self-check',()=>{
  const bag=create(),entry=bag.entries[0]!;
  // 第一条：物品还在实例表里，却从分类袋的格位上消失——模拟一条绕过 clearCells 的写入。
  const orphaned=bag.captureState();
  for(const row of Object.values(orphaned.pouches)){const at=row.indexOf(entry.id);if(at>=0){row.splice(at,1);break;}}
  assert.throws(()=>bag.restoreState(orphaned),/全部页与分类袋的物品不一致/);
  assert.equal(bag.count(entry.item),1,'入口边界拒绝后，现有背包保持原样');
  // 回滚路径故意不校验，正好用它把坏状态灌进去；自检与出口边界都必须发现。
  bag.restoreUnchecked(orphaned);
  assert.throws(()=>bag.verifyConsistency(),/全部页与分类袋的物品不一致/);
  assert.throws(()=>bag.captureState(),/全部页与分类袋的物品不一致/);
  // 第二条：身上穿着一件实例表里根本没有的装备。
  const ghost=create().captureState();ghost.worn['main-hand']='ghost-instance';
  assert.throws(()=>verifyBagState(ghost,catalog),/背包装备引用无效/);
});

test('items whose effect is not implemented are refused instead of silently consumed',()=>{
  const bag=create(),definitions=catalog.items;
  // 符文没有任何分支结算；consume 是导出器的兜底 kind，只有卓越灵药实现了用途。
  // （骰子原先在这里，现在按物品说明「可以重置角色的能力」实现为重置属性，见导出器 item_effects.py。）
  const refused=[
    prepareItem(bag,item=>item.use?.kind==='dungeon'),
    prepareItem(bag,(item,id)=>item.use?.kind==='consume'&&!IMPLEMENTED_CONSUMABLES.includes(id)),
  ];
  for(const entry of refused){
    const before=bag.count(entry.item);
    assert.throws(()=>bag.use(entry.id),/尚未实现/,entry.item);
    assert.equal(bag.count(entry.item),before,entry.item);
    assert.ok(bag.get(entry.id),entry.item);
    // 界面禁用「使用」与 Bag 拒绝共用同一份判断。
    assert.equal(unimplementedItemUse(entry.item,definitions[entry.item]),USE_NOT_IMPLEMENTED,entry.item);
  }
  // 卓越灵药是 consume 里唯一的例外，照旧能用。技能点的实际发放见 story-skills 用例。
  bag.add(SKILL_POINT_ITEM);const elixir=bag.entries.find(entry=>entry.item===SKILL_POINT_ITEM)!;
  assert.equal(unimplementedItemUse(SKILL_POINT_ITEM,definitions[SKILL_POINT_ITEM]),undefined);
  bag.use(elixir.id);assert.equal(bag.get(elixir.id),undefined);
});

test('discard and a new session preserve inventory consistency',()=>{
  const bag=create(),potion=prepareItem(bag,d=>d.shortcut&&d.use?.kind==='consume');
  const material=prepareItem(bag,d=>d.discardable&&d.stackable&&d.category==='material');bag.add(material.item,2);
  assert.throws(()=>bag.discard(material.id,4),/数量/);assert.equal(bag.count(material.item),3);
  bag.discard(material.id,2);assert.equal(bag.count(material.item),1);
  assert.equal(create('dark-knight',()=>{},[potion.item]).count(potion.item),1);
});

test('collected quest items can be handed in without changing character attributes',()=>{
  const campaign=parseCampaign(read('campaign')),quest=campaign.quests.find(q=>q.goals.some(goal=>goal.kind==='item'))!,goal=quest.goals.find(goal=>goal.kind==='item')!;
  const fixture={...campaign,quests:[{...quest,availableWhen:undefined,goals:[{...goal,quantity:1}],handoverItems:[{item:goal.target,quantity:1}]}]};
  const session=new Session(fixture,undefined,{classId:'dark-knight',appearance:read('world').actors[campaign.start.actor]},catalog);
  const initial=session.player;
  assert.equal(session.itemCount(goal.target),0);session.accept(quest.id);
  session.applyStoryCommands([{type:'item-give',item:goal.target,quantity:1}]);
  assert.equal(session.status(quest.id),'ready');assert.ok(session.complete(quest.id));
  assert.equal(session.itemCount(goal.target),0);assert.deepEqual(session.player,initial);
});

test('dragging an item into any empty cell of its own pouch parks it there and leaves its own cell empty',()=>{
  let updates=0;const bag=new Bag(()=>updates++,catalog,'dark-knight');const [potion]=pick('consumable',1);bag.add(potion!);
  const id=bag.entries[0]!.id,counts=bag.counts;
  assert.equal(bag.placeInCell(id,'consumable',9),true);
  assert.equal(bag.pouchCells.consumable[9]!.id,id,'停在这一格');
  assert.equal(bag.pouchCells.consumable[0],undefined,'原格留空');
  assert.equal(bag.entries.length,1,'物品不重不漏');
  assert.deepEqual(bag.counts,counts,'数量不变');
  assert.equal(updates,1,'落格只通知一次');
});

test('dragging an item onto an occupied cell of the same pouch swaps the two',()=>{
  let updates=0;const bag=new Bag(()=>updates++,catalog,'dark-knight');const [first,second]=weapons(2);bag.add(first!);bag.add(second!);
  const before=bag.entries.map(entry=>entry.id);
  assert.equal(bag.placeInCell(before[0]!,'weapon',1),true);
  assert.equal(bag.pouchCells.weapon[0]!.id,before[1]);
  assert.equal(bag.pouchCells.weapon[1]!.id,before[0]);
  assert.equal(bag.pouchCells.weapon.filter(Boolean).length,2,'物品不重不漏');
  assert.equal(updates,1,'换位置只通知一次');
});

test('a drop that crosses pouches, hits its own cell, or names an invalid cell changes nothing',()=>{
  let updates=0;const bag=new Bag(()=>updates++,catalog,'dark-knight');
  const [sword]=weapons(1),[gem]=pick('material',1);bag.add(sword!);bag.add(gem!);
  const id=bag.entries.find(entry=>entry.item===sword)!.id;
  assert.equal(bag.placeInCell(id,'material',4),false,'每个袋是独立背包，不能跨袋落格');
  assert.equal(bag.placeInCell(id,'weapon',0),false,'自己的格位');
  assert.equal(bag.placeInCell('owned-999999','weapon',3),false,'未知实例');
  assert.equal(bag.placeInCell(id,'weapon',-1),false,'负数格位');
  assert.equal(bag.placeInCell(id,'weapon',1.5),false,'非整数格位');
  assert.equal(bag.placeInCell(id,'weapon',Infinity),false,'非有限格位');
  assert.equal(updates,0);
});

test('an emptied stack leaves its cell empty and the next item fills the first free cell',()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');const [first,second,third]=pick('material',3);
  bag.add(first!);bag.add(second!);
  const [head,tail]=bag.entries.map(entry=>entry.id);
  bag.take(head!,1);
  assert.equal(bag.pouchCells.material[0],undefined,'用光的格位留空');
  assert.equal(bag.pouchCells.material[1]!.id,tail,'后面的物品不往前挪');
  bag.add(third!);
  assert.equal(bag.pouchCells.material[0]!.item,third,'新物品填第一个空位');
  assert.equal(bag.pouchCells.material.filter(Boolean).length,2);
});

test('organise compacts all layouts and repeated calls leave the revision alone',()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');const [first,second,third]=pick('material',3);
  bag.add(first!);bag.add(second!);bag.add(third!);
  bag.placeInCell(bag.entries[2]!.id,'material',4);
  assert.equal(bag.pouchCells.material.length,5,'落格在袋里留出空位');
  const before=bag.entries.map(entry=>entry.item).sort();
  bag.organize(catalog.items);
  assert.equal(bag.pouchCells.material.some(entry=>entry===undefined),false,'空位被收拢');
  assert.deepEqual(bag.entries.map(entry=>entry.item).sort(),before,'物品没多也没少');
  const revision=bag.revision;bag.organize(catalog.items);
  assert.equal(bag.revision,revision,'已经整理过就不再通知');
});

test('item counts reuse one map per revision and refresh after inventory changes',()=>{
  const bag=create('dark-knight',()=>{}),[first]=pick('material',1);
  bag.add(first!);
  const counts=bag.counts;
  assert.equal(bag.counts,counts,'没有变化时复用同一份计数');
  assert.equal(bag.count(first!),1);
  const revision=bag.revision;
  bag.counts;bag.count(first!);
  assert.equal(bag.revision,revision,'读计数不推进 revision');
  bag.add(first!);
  assert.notEqual(bag.counts,counts,'背包变化后重建');
  assert.equal(bag.count(first!),2);
  assert.equal(bag.remove(first!,1),true);
  assert.equal(bag.count(first!),1,'消耗后计数同步刷新');
});

test('organise sorts every pouch by category and natural name',()=>{
  const bag=create('dark-knight',()=>{},[...weapons(2),...pouchItems('armor',2),...pick('consumable',2),...pick('material',2),...pick('quest',2)].reverse());
  bag.organize();
  const rank=new Map(organizedInventory(bag.counts,catalog.items).map(([item],index)=>[item,index]));
  for(const [pouch,cells] of Object.entries(bag.pouchCells)){
    const ranked=cells.filter(Boolean).map(entry=>rank.get(entry!.item)!);
    assert.equal(ranked.length,2,`${pouch} 场景准备了两件物品`);
    assert.deepEqual(ranked,[...ranked].sort((a,b)=>a-b),`${pouch} 袋里按名次排好`);
  }
});

test('a dragged layout survives the checkpoint',()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');const [first,second]=pick('material',2);bag.add(first!);bag.add(second!);
  const state=bag.captureState(),id=bag.entries[0]!.id;
  bag.placeInCell(id,'material',6);
  assert.equal(bag.pouchCells.material[6]!.id,id);
  bag.restoreState(state);
  assert.equal(bag.pouchCells.material[0]!.id,id,'检查点带回落格前的位置');
  assert.deepEqual(bag.pouchCells.material.filter(Boolean).map(entry=>entry!.id),bag.entries.map(entry=>entry.id));
});

test('all and category layouts can be dragged independently without changing inventory',()=>{
  let updates=0;const bag=new Bag(()=>updates++,catalog,'dark-knight');
  const [sword]=weapons(1),[ore,gem]=pick('material',2);
  for(const item of [sword!,ore!,gem!])bag.add(item);
  const [weapon,first,second]=bag.allCells.map(entry=>entry!.id),before=bag.counts,pouches=bag.pouchCells;
  assert.equal(bag.placeInCell(weapon!,'all',2),true,'全部里可以跨分类交换');
  assert.deepEqual(bag.allCells.map(entry=>entry!.id),[second,first,weapon]);
  assert.deepEqual(bag.pouchCells,pouches,'全部拖动不改变分类位置');
  const all=bag.allCells;
  assert.equal(bag.placeInCell(first!,'material',5),true);
  assert.deepEqual(bag.allCells,all,'分类拖动不改变全部位置');
  assert.equal(bag.pouchCells.material[0],undefined);
  assert.equal(bag.pouchCells.material[5]!.id,first);
  assert.equal(bag.placeInCell(second!,'all',9),true,'全部可拖入末尾空格');
  assert.equal(bag.allCells[0],undefined);
  assert.equal(bag.allCells[9]!.id,second);
  assert.deepEqual(bag.counts,before,'数量保持不变');
  assert.equal(updates,3);
  for(const cell of [-1,1.5,NaN,Infinity,9])assert.equal(bag.placeInCell(second!,'all',cell),false);
  assert.equal(bag.placeInCell('owned-missing','all',0),false);
  assert.equal(updates,3,'无效落点不通知');
});

test('removal, stacking and pickups maintain both independently arranged layouts',()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');const [first,second,third]=pick('material',3);
  for(const item of [first!,second!])bag.add(item,2);
  const [head,tail]=bag.allCells.map(entry=>entry!.id);
  bag.placeInCell(head!,'material',4);
  bag.add(first!,3);
  assert.equal(bag.allCells[0]!.quantity,5);assert.equal(bag.pouchCells.material[4]!.quantity,5);
  assert.equal(bag.entries.length,2,'堆叠不新增格位');
  bag.take(head!,5);
  assert.equal(bag.allCells[0],undefined);
  assert.equal(bag.allCells[1]!.id,tail,'移出后其他物品不前移');
  bag.add(third!);
  const added=bag.entries.find(entry=>entry.item===third)!;
  assert.equal(bag.allCells[0]!.id,added.id);
  assert.equal(bag.pouchCells.material[0]!.id,added.id,'两个页面分别填自己的第一空格');
  assert.equal(bag.remove(second!,2),true);
  assert.equal(bag.allCells.some(entry=>entry?.id===tail),false);
  assert.equal(bag.pouchCells.material.some(entry=>entry?.id===tail),false);
});

test('organise resets all six layouts in one notification and keeps instances and quantities',()=>{
  const armor=Object.entries(catalog.items).find(([,item])=>pouchFor(item)==='armor')![0];
  let updates=0;const bag=create('dark-knight',()=>updates++,[weapons(1)[0],armor,pick('consumable',1)[0],pick('material',1)[0],pick('quest',1)[0]]),before=bag.entries.sort((a,b)=>a.id.localeCompare(b.id));
  bag.placeInCell(bag.allCells[0]!.id,'all',bag.allCells.length+3);
  for(const pouch of ['weapon','armor','consumable','material','quest'] as const){
    const cells=bag.pouchCells[pouch];bag.placeInCell(cells[0]!.id,pouch,cells.length+2);
  }
  updates=0;bag.organize();
  assert.equal(updates,1);
  assert.deepEqual(bag.allCells.filter(Boolean).map(entry=>entry!.id),bag.entries.map(entry=>entry.id));
  assert.equal(bag.allCells.some(entry=>entry===undefined),false);
  for(const cells of Object.values(bag.pouchCells))assert.equal(cells.some(entry=>entry===undefined),false);
  assert.deepEqual(bag.entries.sort((a,b)=>a.id.localeCompare(b.id)),before);
  bag.organize();assert.equal(updates,1);
});

test('checkpoint copies and restores distinct all and category positions',()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');const [first,second]=pick('material',2);
  bag.add(first!);bag.add(second!);
  const id=bag.allCells[0]!.id;
  bag.placeInCell(id,'all',6);bag.placeInCell(id,'material',3);
  const state=bag.captureState(),saved=structuredClone(state),all=bag.allCells,pouches=bag.pouchCells;
  bag.organize();bag.take(id,1);
  assert.deepEqual(state,saved,'后续改动不修改快照');
  bag.restoreState(state);
  assert.deepEqual(bag.allCells,all);assert.deepEqual(bag.pouchCells,pouches);
  bag.placeInCell(id,'all',0);assert.deepEqual(state,saved,'恢复后的改动也不修改快照');
});

test('initial layout groups categories and equipping or returning gear updates both layouts',()=>{
  const [material]=pick('material',1),weapon=catalog.startingEquipment['dark-knight']['main-hand']!;
  const bag=new Bag(()=>{},{...catalog,startingEquipment:{},startingInventory:[{item:material!,quantity:1},{item:weapon,quantity:1}]},'dark-knight','game');
  assert.deepEqual(bag.allCells.map(entry=>entry!.item),[weapon,material],'开局按分类连续排列');
  const id=bag.allCells[0]!.id;
  bag.equip(id,'main-hand');
  assert.equal(bag.allCells[0],undefined);assert.equal(bag.allCells[1]!.item,material);
  assert.equal(bag.pouchCells.weapon.some(entry=>entry?.id===id),false);
  bag.unequip('main-hand');
  assert.equal(bag.allCells[0]!.id,id);assert.equal(bag.pouchCells.weapon[0]!.id,id);
  assert.equal(bag.entries.length,2);
  const dropped=bag.prepareDrop(weapon);bag.receiveDrop(dropped);
  assert.equal(bag.allCells.filter(entry=>entry?.item===weapon).length,2,'独立装备掉落也进入全部');
});
