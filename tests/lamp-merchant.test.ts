import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Session } from '../src/domain/session.ts';
import { summonLampMerchant } from '../src/domain/lamp-merchant.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const create=()=>new Session(read('campaign') as Campaign,undefined,undefined,read('items') as ItemCatalog);
const at=(map:string)=>({map,x:80,y:80,facing:'south' as const});
const entity=(id:string)=>({id,actor:'lamp-dealer-007',map:'shadow-camp',x:112,y:80});

test('each lamp creates an independent merchant, survives restore, and expires on leaving',()=>{
  const s=create();s.storyWorld.apply({kind:'travel',destination:at('shadow-camp')});s.bag.add('lamp',2);
  const entry=s.bag.entries.find(e=>e.item==='lamp')!;
  const observed:number[][]=[];s.subscribe(()=>observed.push([s.bag.count('lamp'),s.storyWorld.projectEntities('shadow-camp',[]).length]));
  summonLampMerchant(s,entry.id,entity('lamp-merchant-1'));summonLampMerchant(s,entry.id,entity('lamp-merchant-2'));
  assert.deepEqual(observed,[[1,1],[0,2]]);
  const restored=create();restored.restoreState(s.captureState());
  assert.equal(restored.storyWorld.projectEntities('shadow-camp',[]).length,2);
  restored.storyWorld.apply({kind:'travel',destination:at('elsewhere')});
  restored.storyWorld.apply({kind:'travel',destination:at('shadow-camp')});
  assert.equal(restored.storyWorld.projectEntities('shadow-camp',[]).length,0);
});

test('invalid item, changed map and failed consumption leave inventory and world unchanged',()=>{
  const s=create();s.storyWorld.apply({kind:'travel',destination:at('shadow-camp')});s.bag.add('lamp');
  const entry=s.bag.entries.find(e=>e.item==='lamp')!,before=s.captureState();
  assert.throws(()=>summonLampMerchant(s,'missing',entity('one')));
  assert.throws(()=>summonLampMerchant(s,entry.id,{...entity('one'),map:'elsewhere'}));
  const use=s.bag.use;s.bag.use=()=>{throw new Error('consume failed');};
  assert.throws(()=>summonLampMerchant(s,entry.id,entity('one')),/consume failed/);s.bag.use=use;
  assert.deepEqual(s.captureState(),before);
});
