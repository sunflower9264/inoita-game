import test from 'node:test';
import assert from 'node:assert/strict';
import { GameUI,type GameUiView } from '../src/ui/game-ui.ts';
import { wrapText } from '../src/ui/text-layout.ts';

test('CJK wrapping preserves explicit breaks and complete Unicode code points',()=>{
  assert.deepEqual(wrapText('中文😀字\n下一行',2,value=>Array.from(value).length),['中文','😀字','下一','行']);
  assert.deepEqual(wrapText('甲\n\n乙',20,value=>value.length),['甲','','乙']);
});
test('scene time pauses typewriter and toast, and never cuts a surrogate pair',()=>{
  const ui=new GameUI();ui.ready=true;ui.page='甲😀乙';ui.pending=()=>{};ui.toast('提示');
  ui.tick(24);assert.equal(ui.revealed,3);ui.suspended=true;ui.tick(5000);assert.equal(ui.revealed,3);assert.equal(ui.toastMessage,'提示');
  ui.suspended=false;ui.tick(2600);assert.equal(ui.revealed,ui.page.length);assert.equal(ui.toastMessage,'');
});
test('scene time pauses the instant message too, and switching modes clears it',()=>{
  const ui=new GameUI();ui.showInstant('魔法值正在缓慢的恢复。');
  ui.tick(600);assert.equal(ui.instant.alpha,1);
  ui.suspended=true;ui.tick(5000);assert.equal(ui.instant.text,'魔法值正在缓慢的恢复。');
  ui.suspended=false;ui.tick(600);ui.setMode('menu');assert.equal(ui.instant.text,'');assert.equal(ui.instant.alpha,0);
});
test('world rebuild cover survives loading/loaded and is cleared by a mode switch',()=>{
  const ui=new GameUI();let syncs=0;ui.view={sync(){syncs++;},renderText(){},paginate:(_ui,text)=>[{text,end:text.length}],portrait:async()=>undefined};
  ui.setWorldRebuildCover(true);assert.equal(ui.worldRebuildCover,true);assert.equal(syncs,1);
  ui.loading('正在准备剧情…');ui.loaded();assert.equal(ui.worldRebuildCover,true,'加载页状态不能清掉黑幕');
  ui.setWorldRebuildCover(false);assert.equal(ui.worldRebuildCover,false);
  ui.setWorldRebuildCover(true);ui.setMode('game');assert.equal(ui.worldRebuildCover,false,'切模式兜底清除');
});

test('closing a dialogue rejects its waiting page and prevents an old gesture advancing a new one',async()=>{
  const ui=new GameUI();ui.ready=true;const dialogue=ui.dialogue({text:'第一句',speaker:'',actor:null});await Promise.resolve();
  ui.pressDialogue(1);ui.closeDialogue();await assert.rejects(dialogue,{name:'AbortError'});let advanced=0;ui.pending=()=>advanced++;ui.releaseDialogue(1);await Promise.resolve();assert.equal(advanced,0);
});
test('aborted portrait work cannot reattach a picture after the dialog closes',async()=>{
  const ui=new GameUI();let finish!:()=>void;ui.view={sync(){},renderText(){},paginate:(_ui,text)=>[{text,end:text.length}],portrait:()=>new Promise(resolve=>finish=resolve)} satisfies GameUiView;
  const pending=ui.portrait('/picture.png');ui.closeDialogue();finish();await pending;assert.equal(ui.portraitFile,undefined);
});
test('a choice completes once and its old callback cannot select the next choice',async()=>{
  const ui=new GameUI();const option={label:'继续',value:'continue'};const first=ui.choice('选择',[option]);const choose=ui.choices!.choose;choose(option);choose(option);assert.equal(await first,option);
  const controller=new AbortController(),second=ui.choice('下一步',[option],'',controller.signal);choose(option);assert.ok(ui.choices);controller.abort();await assert.rejects(second,{name:'AbortError'});
});

test('a missing optional portrait leaves readable dialogue while cancellation still rejects',async()=>{
  const ui=new GameUI();ui.view={sync(){},renderText(){},paginate:(_ui,text)=>[{text,end:text.length}],portrait:async()=>{throw new Error('missing image');}};
  await ui.portrait('/missing.png');assert.equal(ui.portraitFile,undefined);
  const controller=new AbortController();controller.abort();await assert.rejects(ui.portrait('/missing.png','',controller.signal),{name:'AbortError'});
});
