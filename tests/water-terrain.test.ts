import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {combatMovementSpeed} from '../src/domain/combat-tempo.ts';
import type {WorldMap} from '../src/domain/content.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';

const read=(file:string)=>JSON.parse(readFileSync(new URL(`../public/content/${file}`,import.meta.url),'utf8'));
const map=(water?:number[]):WorldMap=>({id:'water-test',name:'water-test',width:48,height:32,tileSize:16,columns:3,rows:2,
  blocked:[false,false,false,false,false,false],water,ground:'',canopy:'',features:[],entities:[],exits:[]});

test('water lookup follows the foot cell and rejects out-of-bounds points',()=>{
  const navigation=new NavigationWorld(map([0,5]));
  assert.equal(navigation.isWater({x:0,y:0}),true);
  assert.equal(navigation.isWater({x:15,y:15}),true);
  assert.equal(navigation.isWater({x:16,y:0}),false);
  assert.equal(navigation.isWater({x:32,y:16}),true);
  assert.equal(navigation.isWater({x:-1,y:0}),false);
  assert.equal(navigation.isWater({x:48,y:0}),false);
  assert.equal(new NavigationWorld(map()).isWater({x:0,y:0}),false);
});

test('beach exports the original water cells and they remain walkable',()=>{
  const beach=read('maps/beach-146bd453.json') as WorldMap;
  assert.equal(beach.water?.length,220);
  assert.deepEqual(beach.water?.slice(0,10),[0,1,2,3,4,5,6,7,8,9]);
  assert.equal(beach.blocked.some(Boolean),false);
  assert.equal(new NavigationWorld(beach).isWater({x:8,y:8}),true);
});

test('water halves the final combat speed and flying enemies keep their own speed',()=>{
  assert.equal(combatMovementSpeed(100,1000,{gmSpeedMultiplier:1,onWater:true}),50);
  assert.equal(combatMovementSpeed(100,1000,{gmSpeedMultiplier:1,onWater:true,waterImmune:true}),100);
  assert.equal(combatMovementSpeed(100,1000,{gmSpeedMultiplier:1,onWater:false}),100);
  assert.equal(combatMovementSpeed(100,1000,{gmSpeedMultiplier:2,onWater:true}),100);
  assert.equal(combatMovementSpeed(100,500,{gmSpeedMultiplier:2,onWater:true}),50);
});
