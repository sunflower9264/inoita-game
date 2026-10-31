import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoSaver } from '../src/application/auto-save.ts';
import type { SaveGame } from '../src/domain/save-game.ts';

const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const save=(id:string)=>({ format:29, summary:{ classId:'x', className:'x', portrait:'x', level:1, mapId:'m', mapName:'m' },
  session:{} as never, world:{ id } }) as SaveGame<{ id:string }>;

function harness(options:{enabled?:boolean;locked?:boolean;game?:SaveGame<{id:string}>|undefined;writeThrows?:boolean}={}) {
  const writes:SaveGame<{id:string}>[]=[];
  const state={enabled:options.enabled??true,locked:options.locked??false,
    game:'game' in options?options.game:save('auto'),writeThrows:options.writeThrows??false};
  const saver=new AutoSaver<{id:string}>({
    enabled:()=>state.enabled,
    locked:()=>state.locked,
    capture:()=>state.game,
    write:game=>{ if(state.writeThrows)throw new Error('存储已满'); writes.push(game); },
  },{debounceMs:5,retryMs:5,minGapMs:0});
  return {saver,writes,state};
}

test('several triggers inside the debounce window collapse into one write',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  f.saver.request();f.saver.request();f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,1,'三次触发只写一次');
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,2,'窗口结束后的新触发再写一次');
});

test('nothing is written while auto saving is disabled',async t=>{
  const f=harness({enabled:false});t.after(()=>f.saver.stop());
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,0);
  f.state.enabled=true;
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,1);
});

test('a world that is not ready yet is retried until it can be captured',async t=>{
  const f=harness({game:undefined});t.after(()=>f.saver.stop());
  f.saver.request();
  await wait(16);
  assert.equal(f.writes.length,0,'换图途中不写坏档');
  f.state.game=save('auto');
  await wait(24);
  assert.equal(f.writes.length,1,'世界就绪后补写');
});

test('story presentation defers the write instead of saving mid-performance',async t=>{
  const f=harness({locked:true});t.after(()=>f.saver.stop());
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,0);
  f.state.locked=false;
  await wait(24);
  assert.equal(f.writes.length,1);
});

test('a failing storage never throws and stops retrying in a loop',async t=>{
  const f=harness({writeThrows:true});t.after(()=>f.saver.stop());
  assert.doesNotThrow(()=>f.saver.request());
  await wait(20);
  assert.equal(f.writes.length,0);
});

test('stop cancels a pending write',async ()=>{
  const f=harness();
  f.saver.request();
  f.saver.stop();
  await wait(20);
  assert.equal(f.writes.length,0);
});

test('suspend stops writes until resume, including an already pending one',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  // 已经排队的待写在暂停时被清掉：调试现场的安装不该补写一份存档。
  f.saver.request();
  f.saver.suspend();
  assert.equal(f.saver.isSuspended,true);
  await wait(20);
  assert.equal(f.writes.length,0,'暂停期间不写');
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,0,'暂停期间的新触发也不排队');
  f.saver.resume();
  assert.equal(f.saver.isSuspended,false);
  f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,1,'恢复后按正常节奏写一次');
});

test('background flush writes immediately and cancels the queued write',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  f.saver.request();
  f.saver.flushForBackground();
  assert.equal(f.writes.length,1,'页面隐藏时同步写一次');
  await wait(20);
  assert.equal(f.writes.length,1,'排队中的那次不会重复写');
});

test('background flush respects paused, locked and not-ready states',()=>{
  const disabled=harness({enabled:false});
  disabled.saver.flushForBackground();
  assert.equal(disabled.writes.length,0,'不可存档时不写');

  const suspended=harness();
  suspended.saver.suspend();
  suspended.saver.flushForBackground();
  assert.equal(suspended.writes.length,0,'调试暂停时不写');

  const locked=harness({locked:true});
  locked.saver.flushForBackground();
  assert.equal(locked.writes.length,0,'演出或菜单锁着时不写');

  const notReady=harness({game:undefined});
  notReady.saver.flushForBackground();
  assert.equal(notReady.writes.length,0,'世界没就绪时不写');
});

test('the timer writes on its own schedule',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  f.saver.start(10);
  await wait(34);
  assert.ok(f.writes.length>=1,'定时存档至少写一次');
});

test('quest accept and completion trigger a write while progress-only updates do not',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  let status='locked',version=0;
  const listeners=new Set<()=>void>();
  const session={
    get quests(){return new Map([['q',{status}]])},
    get questBook(){return {version}},
    subscribe(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener);},
  };
  const off=f.saver.watchQuests(session as never);
  status='active';version=1;for(const listener of listeners)listener();
  await wait(20);
  assert.equal(f.writes.length,1,'接取任务写一次');
  status='active';version=2;for(const listener of listeners)listener();
  await wait(20);
  assert.equal(f.writes.length,1,'只有目标进度变化不写');
  status='completed';version=3;for(const listener of listeners)listener();
  await wait(20);
  assert.equal(f.writes.length,2,'完成任务再写一次');
  off();
});

test('repeated triggers are accepted without changing behaviour',async t=>{
  const f=harness();t.after(()=>f.saver.stop());
  for(let i=0;i<4;i++)f.saver.request();
  await wait(20);
  assert.equal(f.writes.length,1);
});
