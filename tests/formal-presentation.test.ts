import test from 'node:test';
import assert from 'node:assert/strict';
import { formalPresentation } from '../src/ui/formal-presentation.ts';
type TestPresentationState={-readonly [K in keyof Parameters<typeof formalPresentation>[0]]:Parameters<typeof formalPresentation>[0][K]};
function state(overrides:Record<string,unknown>={}):TestPresentationState{
  return {mode:'game',ready:true,suspended:false,worldRebuildCover:false,skipBackdrop:false,
    loadingState:undefined,defeatState:undefined,defeated:false,choices:undefined,quest:undefined,
    dialogueLine:undefined,...overrides} as unknown as TestPresentationState;
}
test('full-screen presentation preserves priority without changing flow state',()=>{
  const ui=state({dialogueLine:{text:'对白'},choices:{options:[]},defeatState:{busy:false},defeated:true,loadingState:{label:'加载'}});
  assert.equal(formalPresentation(ui,true,true).panel,'portrait');
  assert.equal(formalPresentation(ui,false,true).panel,'loading');
  ui.loadingState=undefined;assert.equal(formalPresentation(ui,false,true).panel,'defeat');
  assert.ok(ui.choices,'显示决策不清除等待中的选择');
});
test('skip backdrop preserves choices and quest while world rebuild hides them',()=>{
  const quest={definition:{id:'test'},kind:'start'};
  const ui=state({skipBackdrop:true,quest});
  const skip=formalPresentation(ui,false,false);
  assert.equal(skip.quest,quest);assert.equal(skip.backgroundVisible,true);assert.equal(skip.occluded,false);
  ui.worldRebuildCover=true;
  const rebuild=formalPresentation(ui,false,false);
  assert.equal(rebuild.quest,undefined);assert.equal(rebuild.occluded,true);assert.equal(rebuild.panel,'none');
  ui.worldRebuildCover=false;ui.quest=undefined;ui.choices={options:[]} as never;
  assert.equal(formalPresentation(ui,false,false).panel,'choice');
});
test('suspension hides skip without deleting dialogue',()=>{
  const ui=state({suspended:true,dialogueLine:{text:'对白'}});
  const view=formalPresentation(ui,false,true);
  assert.equal(view.showSkip,false);assert.equal(view.occluded,true);
  assert.ok(ui.dialogueLine);
});
