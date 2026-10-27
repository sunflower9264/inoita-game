import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bag } from '../src/domain/bag.ts';
import { SHORTCUT_ENTRY_COUNT, ShortcutBar, defaultShortcutRow, emptyShortcutRow } from '../src/domain/shortcut-bar.ts';
import { parseItemCatalog } from '../src/application/content-validation.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseItemCatalog(read('items'));
/** 只留两瓶药水的小背包：默认行是空的，测的是落格本身而不是开局配置。 */
const create=()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');
  bag.add('healing-potion-s',3);bag.add('healing-potion-m',2);
  return bag;
};
const bar=(bag:Bag,owner='player')=>ShortcutBar.for(bag,owner,[]);

test('a fresh member gets a six-slot row per group; the consumable sits in the sixth slot',()=>{
  const row=defaultShortcutRow(['a','b','c','d','e','f','g'],'potion');
  assert.equal(row.length,SHORTCUT_ENTRY_COUNT);
  // 技能只排每组前五格，第六格留给消耗品；第六门技能因此落在第二组第一格。
  assert.deepEqual(row.slice(0,6),[
    {kind:'skill',id:'a'},{kind:'skill',id:'b'},{kind:'skill',id:'c'},{kind:'skill',id:'d'},{kind:'skill',id:'e'},{kind:'item',id:'potion'}]);
  assert.deepEqual(row.slice(6),[ {kind:'skill',id:'f'}, {kind:'skill',id:'g'}, null, null, null, null]);
});

test('the row is materialised on first read and then stays authoritative',()=>{
  const bag=create(),shortcuts=ShortcutBar.for(bag,'player',['dark-strike'],catalog.startingShortcut);
  assert.deepEqual(shortcuts.page(0)[0],{kind:'skill',id:'dark-strike'});
  assert.deepEqual(shortcuts.page(0)[5],{kind:'item',id:catalog.startingShortcut});
  assert.equal(bag.ensureShortcuts('player',emptyShortcutRow()).length,SHORTCUT_ENTRY_COUNT);
  // 之后学会的技能不会自己跳上来，得在登记屏里放。
  const later=ShortcutBar.for(bag,'player',['dark-strike','phantom-clash']);
  assert.equal(later.page(0)[1],null);
});

test('assigning overwrites the slot; the two groups are independent',()=>{
  const bag=create(),shortcuts=bar(bag);
  shortcuts.assign(0,0,{kind:'item',id:'healing-potion-s'});
  shortcuts.assign(1,4,{kind:'item',id:'healing-potion-m'});
  assert.deepEqual(shortcuts.page(0)[0],{kind:'item',id:'healing-potion-s'});
  assert.deepEqual(shortcuts.page(1)[4],{kind:'item',id:'healing-potion-m'});
  assert.equal(shortcuts.page(0)[4],null, 'another group is untouched');
  shortcuts.assign(0,0,{kind:'skill',id:'dark-strike'});
  assert.deepEqual(shortcuts.page(0)[0],{kind:'skill',id:'dark-strike'},'占用即覆盖，不弹确认');
  for(const [page,slot] of [[-1,0],[2,0],[0,-1],[0,6],[0,.5]])assert.throws(()=>shortcuts.assign(page,slot,null),/快捷|技能组/);
});

test('a skill moves to the last registered slot and keeps only one copy',()=>{
  const bag=create(),player=bar(bag),companion=bar(bag,'companion');
  player.assign(0,1,{kind:'skill',id:'dark-strike'});
  player.assign(0,2,{kind:'skill',id:'dark-strike'});
  assert.equal(player.page(0)[1],null,'同一组里换槽会清掉旧槽');
  assert.deepEqual(player.page(0)[2],{kind:'skill',id:'dark-strike'});
  player.assign(1,3,{kind:'skill',id:'dark-strike'});
  assert.equal(player.page(0)[2],null,'跨组换槽也清掉旧槽');
  assert.deepEqual(player.page(1)[3],{kind:'skill',id:'dark-strike'});
  assert.equal(player.row().filter(entry=>entry?.kind==='skill'&&entry.id==='dark-strike').length,1);
  companion.assign(0,1,{kind:'skill',id:'dark-strike'});
  assert.deepEqual(companion.page(0)[1],{kind:'skill',id:'dark-strike'},'别人的快捷栏不受影响');
  player.clearObject('skill','dark-strike');
  assert(!player.assigned('skill','dark-strike'));
  assert.deepEqual(companion.page(0)[1],{kind:'skill',id:'dark-strike'});
});
test('items may still occupy multiple slots; restoring an old duplicate skill row keeps the last copy',()=>{
  const bag=create(),shortcuts=bar(bag);
  shortcuts.assign(0,0,{kind:'item',id:'healing-potion-s'});
  shortcuts.assign(1,4,{kind:'item',id:'healing-potion-s'});
  assert.deepEqual([shortcuts.page(0)[0],shortcuts.page(1)[4]],[{kind:'item',id:'healing-potion-s'},{kind:'item',id:'healing-potion-s'}]);
  const state=bag.captureState(),row=emptyShortcutRow();
  row[0]={kind:'skill',id:'dark-strike'};row[8]={kind:'skill',id:'dark-strike'};
  state.shortcuts=[['player',row]];
  bag.restoreState(state);
  const restored=bar(bag);
  assert.equal(restored.row().filter(entry=>entry?.kind==='skill'&&entry.id==='dark-strike').length,1);
  assert.deepEqual(restored.page(1)[2],{kind:'skill',id:'dark-strike'},'旧行按后出现的槽位保留');
});

test('emptying an item stack clears its slot but leaves skills alone',()=>{
  const bag=create(),shortcuts=bar(bag);
  shortcuts.assign(0,5,{kind:'item',id:'healing-potion-s'});
  shortcuts.assign(0,0,{kind:'skill',id:'dark-strike'});
  bag.remove('healing-potion-s',bag.count('healing-potion-s'));
  assert.equal(shortcuts.page(0)[5],null);
  assert.deepEqual(shortcuts.page(0)[0],{kind:'skill',id:'dark-strike'});
});

test('leaving the party drops that character row; the checkpoint restores the whole bar',()=>{
  const bag=create(),player=bar(bag);
  player.assign(0,2,{kind:'skill',id:'dark-strike'});
  ShortcutBar.for(bag,'companion',[]).assign(0,2,{kind:'item',id:'healing-potion-m'});
  const saved=bag.captureState();
  bag.removeOwner('companion',true);
  assert(ShortcutBar.for(bag,'companion',[]).page(0).every(entry=>entry===null),'离开队伍后那一行被丢掉，重新读是空的');
  bag.restoreState(saved);
  assert.deepEqual(ShortcutBar.for(bag,'companion',[]).page(0)[2],{kind:'item',id:'healing-potion-m'});
  assert.deepEqual(player.page(0)[2],{kind:'skill',id:'dark-strike'});
});
