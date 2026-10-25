import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(
    'export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}')}`}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const targetStatus=Reflect.get(WorldCombat.prototype,'targetStatus') as (this:unknown)=>unknown;

const definition={id:'wolf'},status={id:'enemy',name:'狼',level:3,health:20,maxHealth:20,sceneLevel:false};

/** 顶部敌人面板只读这几项：操作人目标、队友控制器、最近交战记录与敌人名册。 */
function host(controlledTarget?:string,companionTarget?:string){
  return Object.setPrototypeOf({
    combat:{snapshot:()=>({targetId:controlledTarget}),selectedTargetId:()=>controlledTarget},
    arena:[{key:'enemy',definition}],
    roster:{enemyStatus:(key:string)=>key==='enemy'?status:undefined},
    pendingDefeats:new Set<string>(),
    partyControllers:new Map([
      ['player',{snapshot:()=>({targetId:controlledTarget}),selectedTargetId:()=>controlledTarget}],
      ['mercenary',{snapshot:()=>({targetId:companionTarget}),selectedTargetId:()=>companionTarget}],
    ]),
    app:{session:{combatTick:10,party:{controlledId:'player',activeIds:['player','mercenary']}}},
    focusTargetId:undefined,
  },WorldCombat.prototype);
}

test('the top enemy panel follows a companion into combat when the operator has no target',()=>{
  assert.equal(targetStatus.call(host(undefined,'enemy')),status);
});

test('the operator target stays authoritative when both are set',()=>{
  assert.equal(targetStatus.call(host('enemy','enemy')),status);
});

test('an idle party keeps the top enemy panel hidden',()=>{
  assert.equal(targetStatus.call(host()),undefined);
});

test('a defeated target does not fall back to the panel',()=>{
  const idle=host();
  idle.pendingDefeats.add('enemy');
  assert.equal(targetStatus.call(idle),undefined);
});
