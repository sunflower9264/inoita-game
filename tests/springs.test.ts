import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSprings, rollSpring, rollSpringEffect, SpringVisits } from '../src/domain/springs.ts';
import { BATTLE_BUFF_KEYS } from '../src/domain/battle-semantics.ts';

const springs=parseSprings(JSON.parse(fs.readFileSync(new URL('../public/content/springs.json',import.meta.url),'utf8')));

test('exported springs keep the native five tiers and twenty effects',()=>{
  assert.deepEqual(springs.springs.map(spring=>[spring.name,spring.unlockLevel]),
    [['清澈的泉水',1],['凉爽的泉水',20],['未知的泉水',40],['魔界之泉水',60],['混沌之泉水',80]]);
  assert.equal(springs.effects.length,20);
  assert.equal(new Set(springs.effects.map(effect=>effect.spring)).size,5);
  // 越高的档位效果越杂：清澈的泉水只回血加 buff，混沌之泉水还掺了出怪和技能点。
  const clear=springs.effects.filter(effect=>effect.spring===springs.springs[0]!.id);
  assert.deepEqual(clear.map(effect=>effect.kind),['heal','buff']);
  assert.equal(clear[0]!.percent,100);
  const chaos=springs.effects.filter(effect=>effect.spring===springs.springs[4]!.id);
  assert.ok(chaos.some(effect=>effect.kind==='skill-point'&&effect.points===1));
  assert.ok(chaos.some(effect=>effect.kind==='spawn'&&effect.enemy==='enemy-1000-year-old-fountain-snake-1'));
  for(const effect of springs.effects) assert.ok(effect.text.length>0&&effect.weight>0);
});

test('spring tier follows character level and effects roll by weight',()=>{
  assert.equal(rollSpring(springs,1,()=>0).name,'清澈的泉水');
  assert.equal(rollSpring(springs,19,()=>0).name,'清澈的泉水');
  // 凉爽的泉水要 20 级才解锁；掷到上限时落在这批可选档位的最后一档。
  assert.equal(rollSpring(springs,20,()=>.999).name,'凉爽的泉水');
  assert.equal(rollSpring(springs,39,()=>.999).name,'凉爽的泉水');
  assert.equal(rollSpring(springs,40,()=>.999).name,'未知的泉水');
  assert.equal(rollSpring(springs,80,()=>.999).name,'混沌之泉水');
  assert.throws(()=>rollSpring(springs,0,()=>0),/没有等级/);
  // 清澈的泉水两条效果权重 7000/3000：掷 0.69 还是回血，0.7 起才轮到 buff。
  const clear=springs.springs[0]!.id;
  assert.equal(rollSpringEffect(springs,clear,()=>0).kind,'heal');
  assert.equal(rollSpringEffect(springs,clear,()=>.69).kind,'heal');
  assert.equal(rollSpringEffect(springs,clear,()=>.7).kind,'buff');
  assert.equal(rollSpringEffect(springs,clear,()=>.999).kind,'buff');
});

test('spring buff effects resolve to declared battle buffs',()=>{
  const battle=JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
  const buffs=springs.effects.filter(effect=>effect.kind==='buff');
  assert.equal(buffs.length,11);
  // 七条属性类加四条状态类，每条都要在战斗目录里有定义。
  for(const effect of buffs){
    assert.ok(effect.buff,`${effect.spring} 缺少状态键`);
    assert.ok(BATTLE_BUFF_KEYS.includes(effect.buff),`${effect.buff} 未在 BATTLE_BUFF_KEYS 里声明`);
    assert.ok(battle.statusAttackBuffs[effect.buff],`${effect.buff} 在 battle.json 里缺少定义`);
  }
  const powerUp=battle.statusAttackBuffs['spring-frenzy'];
  assert.deepEqual(powerUp.modifiers.map((row:{attribute:string})=>row.attribute),
    ['physicalAttack','magicAttack','criticalRate','moveSpeed','defense'],'疯癫要同时抬攻击与压防御');
  // 四条泉水效果映射到三个药水病状态；两条“无法使用药水”共用同一个键。
  const springStates=buffs.map(effect=>effect.buff!).filter(key=>key.startsWith('spring-potion')||key==='spring-skill-seal');
  assert.deepEqual(springStates.sort(),['spring-potion-sickness','spring-potion-sickness',
    'spring-potion-weakened','spring-skill-seal']);
  for(const key of ['spring-potion-sickness','spring-potion-weakened','spring-skill-seal']){
    const effect=battle.statusAttackBuffs[key];
    assert.equal(effect.durationMs,18060);
    assert.equal(effect.simulationFrames.lastActiveFrame,300);
    assert.equal(effect.stateDurationProfiles[effect.states[0]].normal.lastActiveFrame,450);
  }
});

test('spring parser rejects broken catalogs',()=>{
  assert.throws(()=>parseSprings({version:2,springs:[],effects:[]}),/泉水内容/);
  assert.throws(()=>parseSprings({version:1,springs:[],effects:[]}),/缺少喝空后的外观/);
  assert.throws(()=>parseSprings({version:1,empty:'well',springs:[{id:'a',name:'甲',unlockLevel:0}],effects:[]}),/泉水档位/);
  assert.throws(()=>parseSprings({version:1,empty:'well',springs:[{id:'a',name:'甲',unlockLevel:1}],
    effects:[{spring:'b',kind:'heal',weight:1,text:'甲'}]}),/不存在的档位/);
  assert.throws(()=>parseSprings({version:1,empty:'well',springs:[{id:'a',name:'甲',unlockLevel:1}],
    effects:[{spring:'a',kind:'heal',weight:0,text:'甲'}]}),/泉水效果不完整/);
});

test('the empty spring uses the waterless well the original switches to',()=>{
  // CHAR_DrinkSpring 的公共尾把泉水 id 写成 npc 38（水井），外观就是那口没有水的石槽。
  assert.equal(springs.empty,'well-7abb1f76');
  const world=JSON.parse(fs.readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8'));
  const empty=world.actors[springs.empty];
  assert.ok(empty,'喝空后的外观必须在 world.json 里');
  // 原版水井同样是 16×16 的阻挡体：喝空只换外观，站位与阻挡都不变。
  assert.deepEqual(empty.collision,{x:-8,y:-8,width:16,height:16});
  assert.notEqual(empty.clips['idle-south'].layers[0].key,world.actors[springs.springs[0]!.id].clips['idle-south'].layers[0].key,
    '空泉水用的是另一张图');
});

test('a spring stays empty for the rest of the map visit',()=>{
  const visits=new SpringVisits();
  visits.enterMap('forest');
  assert.equal(visits.isEmpty('forest','well-1'),false);
  visits.drain('forest','well-1');
  assert.equal(visits.isEmpty('forest','well-1'),true);
  assert.equal(visits.isEmpty('other-map','well-1'),false,'记录只属于当前地图');
  visits.enterMap('other-map');visits.enterMap('forest');
  assert.equal(visits.isEmpty('forest','well-1'),false,'重新进图恢复满水');
  visits.drain('forest','well-1');
  const restored=new SpringVisits();restored.restoreState(visits.captureState());
  assert.equal(restored.isEmpty('forest','well-1'),true,'检查点恢复沿用记录');
  const fresh=new SpringVisits();
  fresh.drain('forest','well-1');
  assert.equal(fresh.isEmpty('forest','well-1'),false,'没进过图时不会把记录挂错地图');
});
