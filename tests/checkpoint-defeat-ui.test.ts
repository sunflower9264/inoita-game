import assert from 'node:assert/strict';
import test from 'node:test';
import { GameUI } from '../src/ui/game-ui.ts';

test('defeat actions require confirmation; cancellation preserves inventory and the input lock',async()=>{
  const ui=new GameUI();let prayers=1,restored=0;
  ui.showDefeat({prayerCount:()=>prayers,revive:()=>{prayers--;return true;},restore:()=>{restored++;}});
  assert.equal(ui.locked,true);assert.equal(ui.defeated,true);
  ui.selectDefeatAction('prayer');ui.cancelDefeatConfirmation();await ui.confirmDefeat();
  assert.equal(prayers,1);assert.equal(restored,0);assert.equal(ui.defeated,true);
  ui.selectDefeatAction('checkpoint');ui.cancelDefeatConfirmation();await ui.confirmDefeat();
  assert.equal(restored,0);assert.equal(ui.locked,true);
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();
  assert.equal(restored,1);assert.equal(ui.defeated,false);assert.equal(ui.locked,false);
});

test('prayer use is single-shot even during repeated confirmation and input while awaiting resurrection',async()=>{
  const ui=new GameUI();let prayers=1,finish!:(value:boolean)=>void,calls=0;
  ui.showDefeat({prayerCount:()=>prayers,revive:()=>{calls++;prayers--;return new Promise(resolve=>finish=resolve);},restore:()=>{throw new Error('unexpected checkpoint');}});
  ui.selectDefeatAction('prayer');const first=ui.confirmDefeat();
  ui.cancelDefeatConfirmation();ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();
  assert.equal(calls,1);assert.equal(prayers,0);assert.equal(ui.defeatState!.busy,true);assert.equal(ui.locked,true);
  finish(true);await first;assert.equal(ui.defeated,false);
});

test('unavailable prayer and a failed restore leave the defeat screen operable',async()=>{
  const ui=new GameUI();let calls=0;
  ui.showDefeat({prayerCount:()=>0,revive:()=>{throw new Error('unavailable');},restore:()=>{calls++;if(calls===1)throw new Error('地图加载失败');}});
  ui.selectDefeatAction('prayer');await ui.confirmDefeat();assert.equal(ui.defeatState!.confirmation,undefined);
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();assert.equal(ui.defeatState!.error,'地图加载失败');assert.equal(ui.defeated,true);
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();assert.equal(calls,2);assert.equal(ui.defeated,false);
});

test('an old asynchronous action cannot close a newer defeat screen',async()=>{
  const ui=new GameUI();let finish!:()=>void;
  ui.showDefeat({prayerCount:()=>0,revive:()=>false,restore:()=>new Promise<void>(resolve=>finish=resolve)});
  ui.selectDefeatAction('checkpoint');const pending=ui.confirmDefeat();ui.closeDefeat();
  ui.showDefeat({prayerCount:()=>2,revive:()=>true,restore:()=>{}});
  finish();await pending;assert.equal(ui.defeated,true);assert.equal(ui.defeatState!.prayerCount,2);
  ui.suspended=true;ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();assert.equal(ui.defeatState!.confirmation,undefined);
});

test('a new wipeout replaces a stale defeat flow instead of being ignored',()=>{
  const ui=new GameUI();
  ui.showDefeat({prayerCount:()=>0,revive:()=>false,restore:()=>{}});
  ui.showDefeat({prayerCount:()=>3,revive:()=>true,restore:()=>{}});
  assert.equal(ui.defeated,true);
  assert.equal(ui.defeatState!.prayerCount,3);
  assert.equal(ui.locked,true);
});
