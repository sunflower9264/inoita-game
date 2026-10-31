import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { DropCatalog } from '../src/domain/drops.ts';
import { rollLegendaryWeapon } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { LegendaryWeapons, legendaryStatGate, pullLegendaryWeapon } from '../src/domain/legendary-weapon.ts';
import { Session } from '../src/domain/session.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),drops=read<DropCatalog>('drops');
const sequence=(values:number[]):(()=>number)=>{let index=0;return()=>values[index++]??0.5;};
const createSession=()=>new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items));

test('the legendary sword gate requires the chosen stat to reach twice the map level',()=>{
  const attributes={strength:10,dexterity:9,intelligence:8,vitality:1,mentality:1};
  assert.deepEqual(legendaryStatGate(attributes,5,()=>0),{stat:'strength',value:10,success:true});
  assert.equal(legendaryStatGate(attributes,5,()=>0.34).success,false);
  assert.equal(legendaryStatGate(attributes,0,()=>0).success,false);
  assert.equal(legendaryStatGate({...attributes,strength:11},5,()=>0).success,true);
});

test('mode 6 rolls a normal weapon, a unique item, and a construction failure',()=>{
  const normal=rollLegendaryWeapon(drops,stats,50,sequence([0.01,0.1,0,0,0]));
  assert.ok(normal);assert.equal(normal.unique,false);assert.equal(normal.grade.grade,0);assert.equal(normal.sockets,true);
  const unique=rollLegendaryWeapon(drops,stats,50,sequence([0.01,0.9,0]));
  assert.ok(unique);assert.equal(unique.unique,true);assert.equal(unique.sockets,false);
  assert.equal(rollLegendaryWeapon(drops,stats,50,sequence([0.97])),undefined);
});

test('the consumed sword is tracked per map because entity ids repeat across maps',()=>{
  const state=new LegendaryWeapons();
  state.markPulled('map-a','the-legendary-sword-cb440e18-005');
  assert.equal(state.isPulled('map-a','the-legendary-sword-cb440e18-005'),true);
  assert.equal(state.isPulled('map-b','the-legendary-sword-cb440e18-005'),false);
  const restored=new LegendaryWeapons();restored.restoreState(state.captureState());
  assert.equal(restored.isPulled('map-a','the-legendary-sword-cb440e18-005'),true);
  assert.equal(restored.isPulled('map-b','the-legendary-sword-cb440e18-005'),false);
});

test('pulling a sword consumes it even on failure and grants a weapon on success',()=>{
  const failed=createSession(),before=failed.bag.entries.length;
  const failure=pullLegendaryWeapon(failed,stats,drops,'map-a','sword-001',100,()=>0,{x:1,y:2});
  assert.equal(failure.success,false);assert.equal(failure.message,'能力不足，无法获得武器。');
  assert.equal(failed.legendaryWeapons.isPulled('map-a','sword-001'),true);
  assert.equal(failed.bag.entries.length,before);
  const success=createSession();
  const result=pullLegendaryWeapon(success,stats,drops,'map-a','sword-002',1,sequence([0,0.01,0.1,0,0,0]),{x:1,y:2});
  assert.equal(result.success,true);assert.equal(result.message,'成功获得武器。');
  assert.equal(success.legendaryWeapons.isPulled('map-a','sword-002'),true);
  assert.equal(success.legendaryWeapons.isPulled('map-b','sword-002'),false);
  assert.equal(success.bag.entries.length,before+1);
});

test('a level-zero map is clamped to level one for the pull',()=>{
  const session=createSession();
  const result=pullLegendaryWeapon(session,stats,drops,'map-zero','sword-zero',0,sequence([0,0.01,0.1,0,0,0]),{x:1,y:2});
  assert.equal(result.success,true);
  assert.equal(session.legendaryWeapons.isPulled('map-zero','sword-zero'),true);
});
