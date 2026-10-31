import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { itemDescriptionBody } from '../src/ui/item-detail-lines.ts';
import { itemNameColor } from '../src/ui/item-name-color.ts';
import { plainDescription } from '../src/domain/description-text.ts';
import { layoutDescriptionText } from '../src/ui/description-text-layout.ts';
import type { ItemCatalog, ItemInstance } from '../src/domain/items.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { parseItemCatalog, parseShops, parseCharacterStats } from '../src/application/content-validation.ts';

const read = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items'), stats = read<CharacterStatsCatalog>('character-stats'), shops = parseShops(read('shops'));
const keyOf = (name: string) => Object.entries(items.items).find(([, value]) => value.name === name)![0];
const entry = (name:string, grade=7):ItemInstance => ({id:'instance',item:keyOf(name),quantity:1,enhancement:3,gems:[],
  numbers:{modifiers:[],gemModifiers:[],magicPercent:20,sockets:3,enhancementUses:7,grade,baseAttack:300,baseDefense:50}});
const describe = (value:ItemInstance, member?:{classId:string;level:number}, concealed=false, classNames?:Record<string,string>) => itemDescriptionBody({
  item:items.items[value.item],entry:value,numbers:stats.equipment[value.item],catalog:stats,grades:shops.grades,member,classNames,
  gemNames:value.gems.map(id=>items.items[id]?.name),concealed});
const classNames = Object.fromEntries((read<{classes:{id:string;name:string}[]}>('story-classes').classes).map(value => [value.id, value.name]));
const bodyText = (body:ReturnType<typeof describe>) => body.rows.map(row=>typeof row==='string'?row:plainDescription(row.parts)).join('\n');

test('weapon descriptions use native type, durability, speed and separate attack lines',()=>{
  const value=entry('短剑'),body=describe(value,{classId:'dark-knight',level:105});
  assert.equal(body.title,'钢铁 短剑+3');assert.equal(body.color,'#00b4ff');
  assert.equal(bodyText(body),`短剑\n等级 ${items.items[value.item].level}\n强化耐久度 7\n宝石孔数量 3\n快\n\n物理攻击 300\n魔法攻击 60`);
});

test('equipment details list the suitable classes and collapse the full roster',()=>{
  const dagger=describe(entry('短剑'),{classId:'dark-knight',level:105},false,classNames);
  assert(bodyText(dagger).includes('适合职业：黑暗骑士、忍者、祭司、狂战士'));
  const bow=describe(entry('基础弓'),{classId:'warrior',level:105},false,classNames);
  assert(bodyText(bow).includes('适合职业：暗影猎手'));
  const armor=describe(entry('皮甲'),{classId:'warrior',level:105},false,classNames);
  assert(bodyText(armor).includes('适合职业：全部职业'));
});

test('armor uses its own grade prefix and only native armor class attributes',()=>{
  const leather=describe(entry('皮甲'),{classId:'dark-knight',level:105});
  assert.equal(leather.title,'高级 皮甲+3');
  assert(bodyText(leather).includes('防御力 50\n暴击率: 10.0%\n左手攻击概率: 5.0%'));
  assert(!bodyText(leather).includes('物理攻击'));
  const cloth=Object.entries(items.items).find(([,item])=>item.typeName==='布甲')![0];
  const value=entry('短剑');value.item=cloth;
  assert(bodyText(describe(value)).includes('魔法攻击增加率: 12.0%'));
  const accessory=Object.entries(items.items).find(([,item])=>item.typeName==='项链')![0];value.item=accessory;
  assert(!bodyText(describe(value)).includes('强化耐久度'));
});

test('native condition colors use the viewed member and retain modifier and introduction colors',()=>{
  const value=entry('短剑');
  const restricted=Object.entries(items.items).find(([,item])=>item.equipment&&!item.equipment.classes.includes('priest'))!;
  value.item=restricted[0];value.numbers!.modifiers=[{stat:'strength',value:8}];value.gems=['novice-jewel'];value.numbers!.gemModifiers=[{stat:'intelligence',value:4}];
  const body=describe(value,{classId:'priest',level:0}),parts=(body.rows[0] as {parts:{text:string;color?:string}[]}).parts;
  assert.equal(parts[0].color,'#ff0000');assert.equal(parts.find(part=>part.text===String(items.items[value.item].level))!.color,'#ff0000');
  assert(parts.some(part=>part.text==='力量: 8'&&part.color==='#7878ff'));
  assert(parts.some(part=>part.text==='镶嵌效果'&&part.color==='#ffffff'));
  assert(parts.some(part=>part.text==='低级宝石：智力 +4'&&part.color==='#bf0000'));
  const potion=Object.entries(items.items).find(([,item])=>item.name==='恢复药水（小）')![0];
  const plain:ItemInstance={id:'potion',item:potion,quantity:4,enhancement:0,gems:[]};
  const description=describe(plain);
  assert.equal(bodyText(description),'恢复2400~3200的生命值。');
  assert.equal((description.rows[0] as {parts:{color?:string}[]}).parts[0].color,'#00b4ff');
});

test('equipment descriptions show the enhancement bonus and named gem effects',()=>{
  const value=entry('短剑');
  value.numbers!.enhancementRule={step:1,threshold:10,extra:1};
  value.gems=['novice-jewel'];
  value.numbers!.gemModifiers=[{stat:'strength',value:3}];
  const text=bodyText(describe(value));
  assert(text.includes('强化效果：+3（攻击 +3）'));
  assert(text.includes('镶嵌效果'));
  assert(text.includes('低级宝石：力量 +3'));
});

test('equipment descriptions guard incomplete gem data',()=>{
  const value=entry('短剑');value.gems=['novice-jewel'];
  assert(bodyText(describe(value)).includes('宝石数据不完整'));
});

test('all fifteen grades retain native colors, including unnamed rare and epic equipment',()=>{
  const colors=[undefined,'#4eff00','#00b4ff','#ffe600','#9c00ff'];
  for(let grade=0;grade<15;grade++){
    const body=describe(entry('短剑',grade));assert.equal(body.color,colors[shops.grades[grade].rarity]);
  }
  assert.equal(describe(entry('短剑',10)).title,'短剑+3');assert.equal(describe(entry('短剑',10)).color,'#ffe600');
  assert.equal(describe(entry('短剑',14)).color,'#9c00ff');
  assert.equal(itemNameColor(4,'chaos'),'#0000ff');assert.equal(itemNameColor(4,'epic-chaos'),'#ff6c00');
});

test('concealed stock changes its title and hides values until purchase without rerolling',()=>{
  const value=entry('短剑'),before=structuredClone(value);
  assert.deepEqual(describe(value,undefined,true),{title:'短剑（未鉴定）',color:'#808080',rows:[],sockets:0});
  assert.deepEqual(value,before);assert(bodyText(describe(value)).includes('强化耐久度 7'));
});

test('color runs keep the same measured Chinese and Unicode line breaks',()=>{
  const parts=[{text:'魔法',color:'#ff0000'},{text:'消耗😀\n下一等级',color:'#00b4ff'}];
  const lines=layoutDescriptionText(parts,3,text=>Array.from(text).length);
  assert.deepEqual(lines.map(line=>line.runs.map(run=>run.text).join('')),['魔法消','耗😀','下一等','级']);
  assert.deepEqual(lines[0].runs,[{text:'魔法',color:'#ff0000',x:0},{text:'消',color:'#00b4ff',x:2}]);
});

test('content validation rejects invalid native presentation colors and grades',()=>{
  const badItems=structuredClone(items);badItems.items[keyOf('短剑')].descriptionParts=[{text:'条件',color:'#not-rgb'}];
  assert.throws(()=>parseItemCatalog(badItems),/RGB/);
  const badStats=structuredClone(stats);badStats.equipment[keyOf('短剑')].defaultGrade=15;
  assert.throws(()=>parseCharacterStats(badStats),/品级/);
});
