import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BattleCharacter, calculateCharacter, equipmentPower, PRIMARY_STATS } from '../src/domain/character-stats.ts';
import { parseCharacterStats, validateCharacterStats, parseItemCatalog, parseBattle, parseWardrobe, validateWardrobe } from '../src/application/content-validation.ts';
import type { ItemDefinition } from '../src/domain/items.ts';
import { costumeRecipe } from '../src/domain/wardrobe.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseCharacterStats(read('character-stats')),items=parseItemCatalog(read('items')),battle=parseBattle(read('battle')),wardrobe=parseWardrobe(read('wardrobe'));
const create=(id='dark-knight')=>{const hero=new BattleCharacter(id,catalog,items);for(const [id,item] of Object.entries(items.items))if(!item.pickup)hero.bag.add(id);return hero;};
const zero={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const find=(hero:BattleCharacter,predicate:(d:ItemDefinition)=>boolean)=>hero.bag.entries.find(e=>predicate(items.items[e.item]))!;

test('native player progression: six bases, level HP, manual points, no companion auto-growth',()=>{
  validateCharacterStats(catalog,items,battle);
  const expected=[[13,9,12,9,5],[9,15,11,7,5],[5,7,9,15,11],[11,7,9,9,15],[7,15,10,5,11],[13,11,12,5,6]];
  battle.classes.forEach((c,index)=>{
    const naked=calculateCharacter(catalog,items,c.id,1,zero,{});
    assert.deepEqual(PRIMARY_STATS.map(key=>naked.attributes[key]),expected[index]);
    assert.equal(naked.maxHealth,712+80*expected[index][2]);assert.equal(naked.maxMana,200);
    const high=calculateCharacter(catalog,items,c.id,105,zero,{});
    assert.deepEqual(high.attributes,naked.attributes);assert.equal(high.maxHealth-naked.maxHealth,104*72);
  });
  const panel=calculateCharacter(catalog,items,'dark-knight',1,zero,{});
  assert.equal(panel.maxHealth,1672);assert.equal(panel.physicalAttack,10);assert.equal(panel.magicAttack,0);
  assert.equal(panel.defense,12);assert.equal(panel.physicalResistance,130);assert.equal(panel.hitRate,926);
  assert.equal(panel.criticalRate,30);assert.equal(panel.criticalDamage,1000);assert.equal(panel.weaponBlock,30);
});

/** 命中基础、回避基础与回避显示的随等级取值；裸装、不加点。 */
test('hit base, evasion base and evasion rate keep their native values across levels and classes',()=>{
  const expected:[number,string,number,number,number,number,number,number][]=[
    [1,'dark-knight',56,926,9,173,130,1672],
    [105,'dark-knight',56,487,9,121,5,9160],
    [1,'priest',88,970,7,171,101,1432],
    [60,'ranger',104,723,15,142,7,5760]];
  for(const [level,classId,hitBase,hitRate,evasionBase,evasionRate,resistance,maxHealth] of expected){
    const panel=calculateCharacter(catalog,items,classId,level,zero,{});
    assert.equal(panel.hitBase,hitBase);assert.equal(panel.hitRate,hitRate);
    assert.equal(panel.evasionBase,evasionBase);assert.equal(panel.evasionBonus,0);
    assert.equal(panel.evasionRate,evasionRate);assert.equal(panel.physicalResistance,resistance);
    assert.equal(panel.maxHealth,maxHealth);
  }
});

/** 职业初始武器覆盖双手 700／长剑·锤 600／短剑·弓 500 三档力量加成率与法杖的智力·精力加成率。 */
test('equipped weapon kind drives the attribute rates and the panel keeps its native values',()=>{
  const expected:[string,string,number,number,number,number,number][]=[
    ['dark-knight','longsword',18,19,956,173,1672],
    ['assassin','dagger',16,17,962,177,1592],
    ['warlock','staff',12,24,1031,171,1432],
    ['priest','mace',17,32,980,171,1432],
    ['ranger','bow',19,25,985,177,1512],
    ['warrior','two-handed',25,21,966,174,1672]];
  for(const [classId,kind,physicalAttack,magicAttack,hitRate,evasionRate,maxHealth] of expected){
    const hero=create(classId),entry=hero.bag.get(hero.bag.equipment['main-hand']!)!;
    assert.equal(items.items[entry.item].kind,kind);
    const panel=calculateCharacter(catalog,items,classId,1,zero,{'main-hand':entry});
    assert.equal(panel.physicalAttack,physicalAttack);assert.equal(panel.magicAttack,magicAttack);
    assert.equal(panel.hitRate,hitRate);assert.equal(panel.evasionRate,evasionRate);
    assert.equal(panel.maxHealth,maxHealth);
  }
});

test('earned experience crosses native level thresholds, refills on level-up, and stops at the cap',()=>{
  const hero=create(),threshold=catalog.experience[0]!;
  hero.setHealth(1);hero.setMana(2);
  assert.equal(hero.addExperience(threshold-1),0);
  assert.deepEqual([hero.level,hero.player.experience,hero.player.health,hero.player.mana],[1,threshold-1,1,2]);
  assert.equal(hero.addExperience(1),1);
  assert.deepEqual([hero.level,hero.player.experience,hero.player.health,hero.player.mana],[2,0,hero.player.maxHealth,hero.player.maxMana]);
  assert.equal(hero.addExperience(catalog.experience[1]!+catalog.experience[2]!+7),2);
  assert.deepEqual([hero.level,hero.player.experience],[4,7]);
  assert.throws(()=>hero.addExperience(-1));
  hero.addExperience(Number.MAX_SAFE_INTEGER);assert.equal(hero.addExperience(100),0);assert.equal(hero.player.experience,0);
});

test('combat resource projections neither heal nor clamp before a real capacity read',()=>{
  const hero=create(),base=hero.player;
  hero.setHealth(base.maxHealth-100);hero.setMana(base.maxMana-20);
  hero.setCombatResourceLimits(base.maxHealth+300,base.maxMana+40);
  assert.deepEqual([hero.player.maxHealth,hero.player.health,hero.player.maxMana,hero.player.mana],
    [base.maxHealth+300,base.maxHealth-100,base.maxMana+40,base.maxMana-20]);
  hero.setHealth(base.maxHealth+300);hero.setMana(base.maxMana+40);
  hero.setCombatResourceLimits(base.maxHealth,base.maxMana);
  assert.deepEqual([hero.player.maxHealth,hero.player.health,hero.player.maxMana,hero.player.mana],
    [base.maxHealth,base.maxHealth+300,base.maxMana,base.maxMana+40]);
  hero.setCombatResourceCapacity('maxHealth',base.maxHealth);
  assert.deepEqual([hero.player.health,hero.player.mana],[base.maxHealth,base.maxMana+40]);
  hero.setCombatResourceCapacity('maxMana',base.maxMana);
  assert.deepEqual([hero.player.health,hero.player.mana],[base.maxHealth,base.maxMana]);
});

test('resource setters affect only their own resource and a zero health capacity stays zero',()=>{
  const hero=create(),base=hero.player;
  hero.spendMana(-50);hero.setHealth(base.maxHealth-50);
  assert.equal(hero.player.mana,base.maxMana+50);
  hero.setCombatResourceLimits(base.maxHealth-100,base.maxMana);
  hero.setMana(20);assert.equal(hero.player.health,base.maxHealth-50);
  hero.setCombatResourceCapacity('maxHealth',0);
  assert.deepEqual([hero.player.maxHealth,hero.player.health,hero.player.mana],[0,0,20]);
  hero.setCombatResourceLimits(base.maxHealth,base.maxMana);assert.equal(hero.player.health,0);
  hero.setHealth(25);assert.equal(hero.player.health,25);
});

test('increasing vitality and synchronizing combat limits does not revive a fallen hero',()=>{
  const hero=create();hero.addExperience(catalog.experience[0]!);
  hero.setCombatResourceLimits(hero.panel.maxHealth,hero.panel.maxMana);
  const previousMaximum=hero.player.maxHealth;
  hero.setHealth(0);hero.allocate('vitality',1);
  hero.setCombatResourceLimits(hero.panel.maxHealth,hero.panel.maxMana);
  assert.equal(hero.player.maxHealth,previousMaximum+80);
  assert.equal(hero.player.health,0);
  hero.clearCombatResourceLimits();
  assert.equal(hero.player.health,0);
});

test('allocation, level cap, attribute reset, character isolation and invalid operations',()=>{
  const hero=create(),other=create('warlock'),initial=hero.panel;
  assert.equal(hero.player.nextLevelExperience,12802);assert.equal(hero.statPoints,0);assert.equal(hero.skillPoints,0);
  assert.throws(()=>hero.allocate('strength',1),/属性点/);
  hero.addExperience(hero.player.nextLevelExperience);assert.equal(hero.statPoints,3);assert.equal(hero.skillPoints,1);assert.equal(hero.player.nextLevelExperience,16253);
  hero.allocate('vitality',1);assert.equal(hero.panel.maxHealth,initial.maxHealth+72+80);
  assert.equal(hero.statPoints,2);hero.allocate('vitality',-1);assert.equal(hero.statPoints,3);
  assert.throws(()=>hero.allocate('vitality',-1));
  hero.addExperience(Number.MAX_SAFE_INTEGER);assert.equal(hero.level,105);assert.equal(hero.statPoints,312);assert.equal(hero.skillPoints,104);
  assert.equal(hero.player.nextLevelExperience,0);hero.addExperience(hero.player.nextLevelExperience);assert.equal(hero.statPoints,312);
  hero.allocate('intelligence',1);hero.resetAttributes();assert.equal(hero.statPoints,312);assert.deepEqual(hero.allocated,zero);
  assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(other.level,1);
});

test('equipment requires level and unequipping preserves instance rolls',()=>{
  const hero=create('warrior'),bag=hero.bag;
  const high=find(hero,d=>!!d.equipment?.dualWield&&d.equipment.classes.includes(hero.classId)&&!d.equipment.locked&&d.level>90);
  const low=find(hero,d=>!!d.equipment?.dualWield&&d.equipment.classes.includes(hero.classId)&&!d.equipment.locked&&d.level===1);
  const before=bag.equipment;
  assert.throws(()=>bag.equip(high.id,'main-hand'),/需要等级/);assert.deepEqual(bag.equipment,before);
  hero.addExperience(Number.MAX_SAFE_INTEGER);bag.equip(high.id,'main-hand');bag.equip(low.id,'off-hand');
  const rolled=bag.get(high.id);bag.unequip('main-hand');
  assert.equal(bag.equipment['main-hand'],undefined);assert.equal(bag.equipment['off-hand'],undefined);
  assert.deepEqual(bag.get(high.id),rolled);assert.ok(bag.entries.some(e=>e.id===low.id));
  assert.equal(hero.player.health,hero.panel.maxHealth);
});

test('fixed rolls persist, enhancement changes actual attack and gems add their stored modifier exactly once',()=>{
  const hero=create(),replica=create();assert.deepEqual(hero.bag.entries,replica.bag.entries);
  const bag=hero.bag,weapon=bag.get(bag.equipment['main-hand']!)!;
  assert.equal(weapon.numbers!.enhancementUses,3);
  const scroll=find(hero,d=>d.use?.kind==='enchant'&&d.use.target==='weapon'&&d.use.maxLevel===33);
  const before=hero.panel,power=equipmentPower(catalog.equipment[weapon.item],weapon);
  // 随机源取高值：第二次判定（+2）不通过，结果就是确定的 +1。
  bag.use(scroll.id,weapon.id,undefined,()=>0.99);
  const enhanced=bag.get(weapon.id)!;assert.equal(enhanced.enhancement,1);assert.equal(enhanced.numbers!.enhancementUses,2);
  const newPower=equipmentPower(catalog.equipment[weapon.item],enhanced);
  assert.equal(newPower.attack,power.attack+1);assert.equal(hero.panel.physicalAttack,before.physicalAttack+1);
  const mismatch=find(hero,d=>d.use?.kind==='enchant'&&d.use.target==='weapon'&&d.use.maxLevel===66);
  assert.match(bag.targetProblem(mismatch.id,weapon.id)!,/强化卷轴不同/);
  const copy=bag.get(weapon.id)!;copy.numbers!.modifiers.push({stat:'strength',value:999});assert.deepEqual(bag.get(weapon.id),enhanced);
  const socketed=bag.entries.find(e=>!!items.items[e.item].equipment?.classes.includes(hero.classId)&&!items.items[e.item].equipment!.locked&&(e.numbers?.sockets??0)>0)!;
  const gem=bag.entries.find(e=>items.items[e.item].use?.kind==='socket'&&e.numbers?.modifiers[0].stat==='strength')??find(hero,d=>d.use?.kind==='socket');
  const modifier=gem.numbers!.modifiers[0];bag.use(gem.id,socketed.id);
  assert.deepEqual(bag.get(socketed.id)!.numbers!.gemModifiers,[modifier]);
  assert.equal(bag.get(socketed.id)!.gems.length,1);
  assert.throws(()=>bag.use(gem.id,socketed.id),/不在背包/);
  hero.recover();assert.deepEqual(bag.get(socketed.id)!.numbers!.gemModifiers,[modifier]);
});

test('enchant odds follow the native rules, and chaos scrolls never spend durability',()=>{
  const hero=create(),bag=hero.bag;
  // 导出侧：混沌卷轴此前因为类别掩码为 0 整条漏掉，现在按同族普通卷轴的掩码并集补上。
  assert.ok(catalog.enchantments['chaos-weapon-scroll']?.dagger,'混沌武器卷轴有规则');
  assert.ok(catalog.enchantments['chaos-armor-scroll']?.cloth,'混沌防具卷轴有规则');
  // 特级卷轴的第二次判定阈值加 300（原版 +0x12c，物品描述写「+2 概率增加 30%」）。
  assert.equal(catalog.enchantments['sp-weapon-enhance-scroll'].dagger.bonusChance,300);
  assert.equal(catalog.enchantments['novice-weapon-scroll'].dagger.bonusChance,undefined);

  const chaos=find(hero,d=>d.use?.kind==='enchant'&&!!d.use.requiresEnhanced&&d.use.target==='weapon');
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  // 混沌卷轴要求「已强化过」：等级为 0 时被领域拒绝。
  assert.match(bag.targetProblem(chaos.id,weapon.id)!,/强化/);
  // 等级 20 时第一次判定阈值是 50000/(10+400)=121，随机取高值必然失败 → 降一级。
  // get() 返回副本，所以摆状态走存档往返这条公开途径。
  const atLevel=(level:number)=>{const state=bag.captureState();
    const target=state.instances.find(entry=>entry.id===weapon.id)!;target.enhancement=level;target.numbers!.enhancementUses=0;bag.restoreState(state);};
  const uses=0;
  atLevel(20);
  bag.use(chaos.id,weapon.id,undefined,()=>0.999);
  assert.equal(bag.get(weapon.id)!.enhancement,19);
  assert.equal(bag.get(weapon.id)!.numbers!.enhancementUses,uses,'混沌卷轴不消耗次数');
  // 卷轴用一张少一张，补一张再做成功分支。
  bag.add(chaos.item);
  const second=bag.entries.find(entry=>entry.item===chaos.item)!.id;
  // 等级 1 时成功，第二次判定阈值 1500/(2+5)=214，随机取低值再升一级（总 +2）。
  atLevel(1);
  bag.use(second,weapon.id,undefined,()=>0);
  assert.equal(bag.get(weapon.id)!.enhancement,3);
  assert.equal(bag.get(weapon.id)!.numbers!.enhancementUses,uses,'仍未消耗次数');
});

test('staff and orb magic power uses generated weapon percentage; bonuses truncate per stat row',()=>{
  const hero=create('warlock'),entry=hero.bag.get(hero.bag.equipment['main-hand']!)!;
  assert.equal(entry.numbers!.magicPercent,130);
  const power=equipmentPower(catalog.equipment[entry.item],entry);
  assert.ok(power.magicAttack>0);
  const panel=calculateCharacter(catalog,items,hero.classId,1,zero,{'main-hand':entry});
  assert.equal(panel.magicAttack,power.magicAttack+9+6);
  const enhanced={...entry,enhancement:10,numbers:{...entry.numbers!,enhancementRule:{step:7,threshold:10,extra:1}}};
  assert.equal(equipmentPower(catalog.equipment[entry.item],enhanced).attack,power.attack+71);
});

test('wardrobe includes all skill timelines and resolves every weapon style without losing class skills',()=>{
  for(const character of battle.classes){
    const clips=wardrobe.skills[character.id];
    for(const id of character.skills)if(battle.skills[id].action)for(const facing of ['north','south','east','west'] as const){
      const key=`skill-${id}-${facing}` as const,pose=wardrobe.poses[clips[key]!];
      assert.ok(pose,key);assert.equal(pose.frames.length,character.actor.clips[key]!.frames,key);
    }
  }
  for(const [stance,poses] of Object.entries(wardrobe.stances)){
    const actor={...battle.classes[0].actor,clips:{...battle.classes[0].actor.clips}};
    for(const facing of ['north','south','east','west'] as const)actor.clips[`attack-${facing}`]={...actor.clips['attack-south']!,frames:wardrobe.poses[poses[`attack-${facing}`]!].frames.length};
    const result=resolveBasicAttack({basicAttacks:{equipped:wardrobe.attacks[stance]}},{actor,basicAttack:{profileId:'equipped',clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}});
    assert.ok(result.effectiveCycleFrames>result.strikeFrame);
  }
  assert.equal(costumeRecipe(wardrobe,items,{}).attack.projectile,null);
});

test('content validation rejects missing equipment and malformed numeric ranges',()=>{
  const missing=structuredClone(catalog);delete missing.equipment[Object.keys(missing.equipment)[0]];
  assert.throws(()=>validateCharacterStats(missing,items,battle),/装备缺失/);
  const invalid=structuredClone(catalog);invalid.experience[0]=null;assert.throws(()=>parseCharacterStats(invalid),/仅满级/);
  const bad=structuredClone(catalog);Object.values(bad.equipment)[0].magicPercent=[130,110];assert.throws(()=>parseCharacterStats(bad),/范围/);
});

test('weapon changes select native skill clips and timing, and unarmed ranger skills are unavailable',()=>{
  const equipment=(kind:string)=>Object.entries(items.items).find(([,d])=>d.kind===kind&&d.equipment)![0];
  const knight=costumeRecipe(wardrobe,items,{'main-hand':equipment('two-handed')},'dark-knight');
  assert.equal(wardrobe.poses[knight.poses['skill-dark-strike-south']!].frames.length,24);
  assert.equal(knight.actions['dark-strike']!.events.find(e=>e.kind==='units')!.frame,12);
  assert.equal(knight.actions['dark-strike']!.events.find(e=>e.kind==='swing')!.frame,10);
  const ranger=costumeRecipe(wardrobe,items,{'main-hand':equipment('crossbow')},'ranger');
  assert.equal(ranger.actions['multiple-shot']!.events.find(e=>e.kind==='units')!.frame,2);
  assert.equal(ranger.actions['multiple-shot']!.repeat!.restartAfterFrame,2);
  assert.equal(wardrobe.poses[ranger.poses['skill-spiritual-arrow-south']!].frames.length,17);
  const unarmed=costumeRecipe(wardrobe,items,{},'ranger');
  for(const id of ['aimed-shot','multiple-shot','spiritual-arrow','rampage'])assert.equal(unarmed.actions[id],null);
  assert.ok(!('net-shackles' in unarmed.actions));
  validateWardrobe(wardrobe,items,battle);
  const invalid=structuredClone(wardrobe);
  invalid.skillStances['dark-knight']['two-handed:empty'].actions['dark-strike']!.events[0].frame=999;
  assert.throws(()=>validateWardrobe(invalid,items,battle),/帧号升序|触发帧越界/);
});

test('hero panel is reused until the bag, level or allocation changes',()=>{
  const hero=new BattleCharacter('dark-knight',catalog,items),first=hero.panel;
  assert.equal(hero.panel,first,'数值与背包都没变时复用同一份面板');
  const material=Object.entries(items.items).find(([,item])=>!item.pickup&&item.category==='material')![0];
  hero.bag.add(material);
  assert.notEqual(hero.panel,first,'背包变化后重新计算');
  const afterBag=hero.panel;
  hero.addExperience(catalog.experience[0]!);
  assert.notEqual(hero.panel,afterBag,'升级后重新计算');
  const afterLevel=hero.panel;
  hero.allocate('strength',1);
  assert.notEqual(hero.panel,afterLevel,'分配属性后重新计算');
  const afterAllocation=hero.panel,state=hero.captureState();
  hero.restoreState({...state,allocation:{...state.allocation,strength:state.allocation.strength+1}});
  assert.notEqual(hero.panel,afterAllocation,'读档恢复属性后重新计算');
});
