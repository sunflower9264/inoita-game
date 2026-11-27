import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicAttackRepeat } from '../src/domain/basic-attack-repeat.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

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

function sceneFixture(){
  const calls:string[]=[];
  const combat={targetId:'enemy' as string|undefined,attackState:'idle' as 'idle'|'approaching'|'attacking',
    castingSkill:false,
    attack:()=>calls.push('attack'),update(){},playerCannotMove:()=>false,movementSpeedForPlayer:()=>4,
    cancelAttack:()=>calls.push('cancelAttack'),clearTarget:()=>calls.push('clearTarget'),cancelAmbushOnDirection(){},controlledId:'player',
    switchControl:()=>true,switchMember:()=>true};
  const worldHud={axis:{x:0,y:0},updateFps(){},updateStatus(){}};
  const scene=buildTestWorldScene(WorldScene,{
    player:{container:{x:0,y:0}},
    movement:{drive:()=>calls.push('drive'),stop(){}},
    combat,
    worldHud,
    app:{ui:{ready:true} as never,locked:false,suspended:false,director:{busy:false} as never,session:{combatTick:0,refresh(){}} as never},
  });
  return {scene,state:{worldHud},combat,calls};
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

test('an offensive skill completion starts a basic attack and searches once when no target is selected',()=>{
  const {scene,combat,calls}=sceneFixture();
  combat.targetId=undefined;
  scene.offensiveSkillCompleted('other');scene.update(0,16);
  assert.equal(calls.filter(call=>call==='attack').length,0,'其他队员的技能不替当前角色启动普攻');
  scene.offensiveSkillCompleted('player');scene.update(0,16);
  assert.equal(calls.filter(call=>call==='attack').length,1,'第一次普攻允许按普攻规则搜索目标');
  scene.update(0,16);
  assert.equal(calls.filter(call=>call==='attack').length,1,'找不到目标不重复尝试');
  assert.equal(scene.autoAttack.active,false);
  combat.targetId='enemy';scene.offensiveSkillCompleted('player');scene.update(0,16);scene.update(0,16);
  assert.equal(calls.filter(call=>call==='attack').length,3,'找到目标后继续普通连打');
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
  moving.state.worldHud.axis={x:1,y:0};
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
  state.worldHud.axis={x:1,y:0};
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
  const nearby={actor:{},entity:{}} as unknown as NonNullable<InstanceType<typeof WorldScene>['near']>;
  let interactResult=true;
  const scene=buildTestWorldScene(WorldScene,{
    player:{container:{x:0,y:0}},
    near:nearby,
    worldHud:{axis:{x:0,y:0},updateFps(){},updateStatus(){}},
    movement:{drive(){},stop(){}},
    combat:{targetId:'enemy' as string|undefined,attackState:'idle' as 'idle'|'approaching'|'attacking',
      attack:()=>calls.push('attack'),update(){},playerCannotMove:()=>false,movementSpeedForPlayer:()=>4,
      cancelAttack(){},clearTarget(){},cancelAmbushOnDirection(){},controlledId:'player'},
    app:{ui:{ready:true} as never,locked:false,suspended:false,director:{busy:false} as never,session:{combatTick:0,refresh(){}} as never},
    sceneOverrides:{updateInteractionTarget(){},interact(){calls.push('interact');return interactResult;}},
  });
  scene.attackKey();
  assert.deepEqual(calls,['interact'],'已选中敌人时也优先开箱／喝水／对话');
  assert.equal(scene.autoAttack.active,false,'交互不算发起普攻');
  scene.near=null;
  scene.attackKey();
  assert.deepEqual(calls,['interact','attack'],'身边没有可交互物才落普攻');
  assert.equal(scene.autoAttack.active,true);
  // 身边有可交互物、但这一下交互没成（例如目标这一刻不能交互）也落回普攻。
  interactResult=false;
  scene.near=nearby;
  scene.attackKey();
  assert.deepEqual(calls,['interact','attack','interact','attack'],'交互落空时发普攻');
});
