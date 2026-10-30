import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { BasicAttackRepeat } from '../src/domain/basic-attack-repeat.ts';

// 场景层的接线用例：用假 phaser 模块直接跑 Scene.update 的普攻分支，不需要浏览器。
const phaser = registerHooks({resolve(specifier, context, next) {
  return specifier === 'phaser' ? {url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true} : next(specifier,context);
}});
const { WorldScene } = await import('../src/scenes/world-scene.ts');
phaser.deregister();

test('the repeat gate only continues an engaged attack while the character stands idle',()=>{
  const repeat=new BasicAttackRepeat();
  assert.equal(repeat.next({targetId:'enemy',attackState:'idle'}),false,'未按过攻击键就不出手');
  repeat.engage();
  assert.equal(repeat.next({targetId:'enemy',attackState:'idle'}),true);
  assert.equal(repeat.next({targetId:'enemy',attackState:'attacking'}),false);
  assert.equal(repeat.next({targetId:'enemy',attackState:'approaching'}),false);
  assert.equal(repeat.active,true,'动作还没结束，连打仍然记着');
  assert.equal(repeat.next({targetId:undefined,attackState:'idle'}),false,'目标没了就停');
  assert.equal(repeat.active,false);
  assert.equal(repeat.next({targetId:'enemy',attackState:'idle'}),false,'重新选到目标也要再按一次攻击键');
  repeat.engage();
  assert.equal(repeat.next({targetId:'enemy',attackState:'idle'}),true);
});

/** 只声明用例要碰的部分，避免测试去动场景的私有成员。 */
interface SceneHooks {
  update(time:number,delta:number):void;
  interact():void;
  attackKey():void;
  startBasicAttack():void;
  switchControlled(id:string):boolean;
  switchMember(direction:-1|1):void;
  autoAttack:BasicAttackRepeat;
}

function sceneFixture(){
  const calls:string[]=[];
  const combat={targetId:'enemy' as string|undefined,attackState:'idle' as 'idle'|'approaching'|'attacking',
    castingSkill:false,
    attack:()=>calls.push('attack'),update(){},setPerformanceActive(){},playerCannotMove:()=>false,movementSpeedForPlayer:()=>4,
    cancelAttack:()=>calls.push('cancelAttack'),clearTarget:()=>calls.push('clearTarget'),cancelAmbushOnDirection(){},controlledId:'player',
    switchControl:()=>true,switchMember:()=>true};
  const state={
    player:{},characters:[],performing:false,loadingWorld:false,destroyed:false,
    autoAttack:new BasicAttackRepeat(),
    stick:{axis:{x:0,y:0}},
    movement:{drive:()=>calls.push('drive'),stop(){}},
    combat,refreshShortcutPage(){},
    app:{ui:{ready:true},locked:false,suspended:false,director:{busy:false},session:{combatTick:0,refresh(){}}},
    sys:{isActive:()=>true}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as SceneHooks;
  return {scene,state,combat,calls};
}

test('the scene keeps a started attack going while the stick is at rest',()=>{
  const {scene,combat,calls}=sceneFixture();
  const attacks=()=>calls.filter(call=>call==='attack').length;
  scene.update(0,16);
  assert.equal(attacks(),0,'没按过攻击键，站定也不会自己出手');
  scene.startBasicAttack();
  assert.equal(attacks(),1);
  scene.update(0,16);
  assert.equal(attacks(),2,'动作空闲就自动接下一击');
  assert.ok(calls.includes('drive'),'站定时照常驱动移动');
  combat.attackState='attacking';
  scene.update(0,72);
  assert.equal(attacks(),2,'动作没结束不插新的一击');
});

test('the scene drops the repeat when the stick moves or the target is gone',()=>{
  const {scene,combat,calls}=sceneFixture();
  const attacks=()=>calls.filter(call=>call==='attack').length;
  scene.startBasicAttack();
  combat.targetId=undefined;
  scene.update(0,16);
  assert.equal(attacks(),1,'目标没了不再出手');
  assert.equal(scene.autoAttack.active,false);
  combat.targetId='enemy';
  scene.update(0,16);
  assert.equal(attacks(),1,'要重新按攻击键才会再连打');

  const moving=sceneFixture();
  moving.scene.startBasicAttack();
  moving.state.stick.axis={x:1,y:0};
  moving.scene.update(0,16);
  assert.ok(moving.calls.includes('cancelAttack'),'普攻仍会被摇杆取消');
  assert.ok(moving.calls.includes('clearTarget'),'摇杆一动先清目标');
  assert.equal(moving.calls.filter(call=>call==='attack').length,1);
  assert.equal(moving.scene.autoAttack.active,false,'连打随清目标一起停');
});

test('the scene ignores the stick while an active skill is being released',()=>{
  const {scene,state,combat,calls}=sceneFixture();
  scene.startBasicAttack();
  calls.length=0;
  combat.castingSkill=true;
  state.stick.axis={x:1,y:0};
  scene.update(0,16);
  assert.equal(calls.includes('cancelAttack'),false,'技能期间不被移动取消');
  assert.equal(calls.includes('clearTarget'),false,'技能期间不清目标');
  assert.equal(calls.includes('drive'),false,'技能期间不驱动移动');
  assert.equal(scene.autoAttack.active,true,'技能期间保留连打状态');

  combat.castingSkill=false;
  scene.update(0,16);
  assert.ok(calls.includes('cancelAttack'),'技能结束后摇杆恢复取消普攻');
  assert.ok(calls.includes('clearTarget'));
  assert.ok(calls.includes('drive'));
});

test('switching the controlled member drops the repeat gate',()=>{
  const {scene}=sceneFixture();
  scene.startBasicAttack();
  assert.equal(scene.autoAttack.active,true);
  assert.equal(scene.switchControlled('ally'),true);
  assert.equal(scene.autoAttack.active,false,'头像切人后不再自动接下一击');
  scene.startBasicAttack();
  scene.switchMember(1);
  assert.equal(scene.autoAttack.active,false,'Q/E 切人同样停止连打');
});

test('interacting does not arm the repeat',()=>{
  const {scene,calls}=sceneFixture();
  scene.interact();
  assert.equal(scene.autoAttack.active,false);
  scene.update(0,16);
  assert.equal(calls.includes('attack'),false,'按交互键之后不会自动接着打');
});

test('the attack key interacts with a nearby object before attacking',()=>{
  const calls:string[]=[];
  const state={
    player:{},characters:[],performing:false,loadingWorld:false,destroyed:false,
    autoAttack:new BasicAttackRepeat(),
    near:{actor:{},entity:{}} as {actor:object;entity:object}|null,
    stick:{axis:{x:0,y:0}},movement:{drive(){},stop(){}},
    updateInteractionTarget(){},interact(){calls.push('interact');return true;},
    combat:{targetId:'enemy' as string|undefined,attackState:'idle' as 'idle'|'approaching'|'attacking',
      attack:()=>calls.push('attack'),update(){},setPerformanceActive(){},playerCannotMove:()=>false,movementSpeedForPlayer:()=>4,
      cancelAttack(){},clearTarget(){},cancelAmbushOnDirection(){},controlledId:'player'},
    refreshShortcutPage(){},
    app:{ui:{ready:true},locked:false,suspended:false,director:{busy:false},session:{combatTick:0,refresh(){}}},
    sys:{isActive:()=>true}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as SceneHooks;
  scene.attackKey();
  assert.deepEqual(calls,['interact'],'已选中敌人时也优先开箱／喝水／对话');
  assert.equal(scene.autoAttack.active,false,'交互不算发起普攻');
  state.near=null;
  scene.attackKey();
  assert.deepEqual(calls,['interact','attack'],'身边没有可交互物才落普攻');
  assert.equal(scene.autoAttack.active,true);
  // 身边有可交互物、但这一下交互没成（例如没朝着它）也按原版落回普攻。
  state.interact=()=>{calls.push('interact');return false;};
  state.near={actor:{},entity:{}} as {actor:object;entity:object}|null;
  scene.attackKey();
  assert.deepEqual(calls,['interact','attack','interact','attack'],'交互落空时发普攻');
});
