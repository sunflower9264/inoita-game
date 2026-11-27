import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

test('GM noclip follows the controlled character and clears the previous one',()=>{
  const calls:[string,boolean][]=[];
  const a={container:{active:true}},b={container:{active:true}};
  const combat={controlledVisual:a as unknown};
  const scene=buildTestWorldScene(WorldScene,{
    app:{gmNoclip:false},
    player:a,
    combat,
    movement:{setNoclip:(visual:{container:{active:boolean}},enabled:boolean)=>{calls.push([visual===a?'a':'b',enabled]);},position:()=>({x:0,y:0})},
    sceneOverrides:{
      cameras:{main:{startFollow(){}}},
      refreshCombatTarget(){},syncHud(){},
    },
  });
  scene.setNoclip(true);
  assert.deepEqual(calls,[['a',true]]);
  combat.controlledVisual=b;
  scene.syncControlledCharacter();
  assert.deepEqual(calls,[['a',true],['a',false],['b',true]],'换人后旧角色必须关闭穿墙');
  scene.setNoclip(false);
  assert.deepEqual(calls,[['a',true],['a',false],['b',true],['b',false]],'关闭穿墙要清掉当前角色');
});
