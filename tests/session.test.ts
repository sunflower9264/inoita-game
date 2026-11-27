import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session } from '../src/domain/session.ts';
import { encounterSpawnId } from '../src/domain/world-enemies.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import type { StoryUI } from '../src/domain/story-director.ts';
import { canStandOnTerrain, ExitTrigger } from '../src/domain/navigation.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
const campaign=JSON.parse(fs.readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;

test('nested atomic joins the outer rollback and restores subsystems declared by the inner call',()=>{
 const session=new Session(campaign);
 session.gainMoney(100);session.bag.add('healing-potion-s',1);
 const before=session.captureState();
 let updates=0;session.subscribe(()=>updates++);
 assert.throws(()=>session.atomic(()=>{
   session.gainMoney(5);
   session.atomic(()=>{session.bag.add('healing-potion-s',2);throw new Error('内层失败');},['bag']);
 },['coins']),/内层失败/);
 assert.deepEqual(session.captureState(),before,'外层统一回滚，内层新碰到的背包也恢复');
 assert.equal(updates,0,'失败的事务不通知界面');
});

test('native assassination progress requires a defeat and markers follow its delivery state',()=>{
 const session=new Session(campaign);
 assert.equal(session.marker('darius','npc-40'),null);
 assert.equal(session.interact('earl-grafton','cave-grafton','npc-109'),false);
 assert.equal(session.complete('grafton-mission'),false);
 assert.equal(session.accept('grafton-mission'),true);assert.equal(session.marker('darius','npc-40'),'active');
 assert.equal(session.accept('grafton-mission'),false);
 assert.equal(session.interact('earl-grafton','cave-grafton','npc-109'),false);
 session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
 assert.equal(session.marker('darius','npc-40'),'ready');
 assert.equal(session.complete('grafton-mission'),true);assert.equal(session.complete('grafton-mission'),false);
 assert.equal(session.marker('darius','npc-40'),null);
 assert.equal(session.markerActor('darius','npc-40'),false,'任务完成后不再把交付人算作可交互对象');
 assert.equal(session.status('cardinal-summons'),'available');
 assert.equal(session.marker('janus','npc-55'),null,'event-granted quests have no offer marker before their script grants them');
});
test('journal-external quests keep scene markers because journal: false only hides the journal',()=>{
 const session=new Session(campaign);
 // quest-381「序幕_战斗任务」不进任务日志，但它的交付对象是丛林路障，玩家必须能找到。
 assert.equal(session.questBook.journalVisible('quest-381'),false);
 assert.equal(session.accept('quest-381'),true);
 assert.equal(session.status('quest-381'),'ready');
 assert.equal(session.marker('barricade-a1eb664e','npc-120'),'ready');
 assert.equal(session.markerActor('barricade-a1eb664e','npc-120'),true,'日志外待交付仍要挂头顶标记');
});

test('journal-external active goal targets keep scene markers until the goal is done',()=>{
 const session=new Session(campaign);
 // 山寨开关是日志外任务 quest-150 的交互目标；目标没完成前也要看见。
 assert.equal(session.accept('quest-150'),true);
 assert.equal(session.status('quest-150'),'active');
 assert.equal(session.marker('switch-81c1a471','npc-297'),'active');
 assert.equal(session.markerActor('switch-81c1a471','npc-297'),true);
});

test('talk and interact goal markers disappear once the goal is complete',()=>{
 const rules:CampaignQuest={id:'goal-marker',title:'目标标记',description:'',giver:'giver',delivery:'delivery',
   guidance:{available:'接取',active:'进行中'},completion:'all',
   goals:[{id:'talk',kind:'talk',target:'target',quantity:1}],progressText:'',completeText:''};
 const session=new Session({...campaign,quests:[rules],placements:[],questGroups:[],events:[]} as Campaign);
 assert.equal(session.accept('goal-marker'),true);
 assert.equal(session.status('goal-marker'),'active');
 assert.equal(session.marker('target','target-instance'),'active');
 assert.equal(session.markerActor('target','target-instance'),true);
 session.interact('target','target-instance');
 assert.equal(session.marker('target','target-instance'),null,'目标完成后不挂标记');
 assert.equal(session.markerActor('target','target-instance'),false);
});

test('an arrival next to an exit does not re-trigger before the player walks clear',()=>{
 const exits=[{x:32,y:32,width:16,height:16,destination:'next'},{x:32,y:48,width:16,height:16,destination:'next'}];
 // 落点离出口只有 8 像素：向东一步就压住出口，也不能立刻回上一张图。
 const gate=new ExitTrigger(exits,{x:24,y:40});
 assert.equal(gate.update({x:25,y:40},true),null,'贴门落点先锁住');
 assert.equal(gate.update({x:40,y:40},true),null,'没走满 80 像素前仍然锁住');
 // 还没走满 80 像素，继续走；累计满 80 后主动走回来才允许离开。
 assert.equal(gate.update({x:0,y:40},true),null);
 assert.equal(gate.update({x:40,y:40},true),exits[0]);
 // 触发后整簇门洞重新上锁，原地再调用不会重复触发。
 assert.equal(gate.update({x:40,y:40},true),null);
 gate.update({x:0,y:40},true);
 assert.equal(gate.update({x:40,y:40},true),exits[0]);
});

test('an exit away from the arrival point still triggers on first entry',()=>{
 const exit={x:96,y:32,width:16,height:16,destination:'next'},gate=new ExitTrigger([exit],{x:0,y:40});
 assert.equal(gate.update({x:90,y:40},true),exit);
});

test('a spawn inside an exit requires walking clear of that doorway first',()=>{
 const exit={x:32,y:32,width:16,height:16,destination:'next'},gate=new ExitTrigger([exit],{x:40,y:40});
 assert.equal(gate.update({x:49,y:40},true),null,'还在缓冲区');
 gate.update({x:0,y:40},true);
 assert.equal(gate.update({x:40,y:40},true),exit);
});
test('an exit only fires after the player has walked the rearm distance',()=>{
 const exit={x:0,y:0,width:200,height:200,destination:'next'},gate=new ExitTrigger([exit],{x:50,y:50});
 assert.equal(gate.update({x:129,y:50},true),null,'累计 79px，还差 1px');
 assert.equal(gate.update({x:130,y:50},true),exit,'累计满 80px 后脚底压住出口就触发');
});
test('the goblin lair doorway opens after 80px of movement',()=>{
 const north={x:64,y:0,width:64,height:16,destination:'goblin-prison-2-27ab25e1'};
 const gate=new ExitTrigger([north],{x:88,y:24});
 assert.equal(gate.update({x:88,y:104},true),null,'走了 80px，但还不在出口格里');
 assert.equal(gate.update({x:88,y:8},true),north,'回到出口格里才触发');
});
test('the foot can reach a blocked edge exit from its walkable approach',()=>{
 const map={name:'fixture',tileSize:16,columns:4,rows:3,blocked:Array.from({length:12},(_,i)=>i%4===3)};
 const exit={x:48,y:16,width:16,height:16},gate=new ExitTrigger([exit],{x:0,y:24});
 const p=new NavigationWorld(map).constrainTerrain({x:24,y:24},30,0);
 assert.ok(p.x<48&&canStandOnTerrain(map,p.x,p.y));
 // 先走满 80px 缓冲区；这一段只验证距离，不验证地形。
 assert.equal(gate.update({x:0,y:104},true),null);
 assert.equal(gate.update(p,true),exit);
});
test('dialogue work serializes and always releases the input lock',async()=>{
 const session=new Session(campaign),locks: boolean[]=[];
 const ui: StoryUI={closeDialogue(){},skipDialogue(){},dialogue:async()=>{},choice:async()=>{throw new Error('unused');},questPopup:async()=>{}};
 const director=new StoryDirector(campaign,session,ui,v=>locks.push(v));
 let release!: (value?: void | PromiseLike<void>) => void;const work=director.run(()=>new Promise(resolve=>release=resolve));
 assert.equal(await director.run(()=>{throw new Error('duplicate');}),false);
 release();await work;assert.deepEqual(locks,[true,false]);
 await assert.rejects(director.run(()=>Promise.reject(new Error('failed'))));assert.equal(director.busy,false);
});
test('blocking cells, diagonal sliding, bounds and long frames cannot be crossed',()=>{
 const map={name:'fixture',tileSize:16,columns:5,rows:5,blocked:Array.from({length:25},(_,i)=>i%5===2)};
 assert.equal(canStandOnTerrain(map,40,24),false);assert.equal(canStandOnTerrain(map,-2,24),false);
 const end=new NavigationWorld(map).constrainTerrain({x:8,y:24},200,12);assert.ok(end.x<32);assert.ok(end.y>24);
 const corrected=new NavigationWorld(map).nearest({}, {x:40,y:24});assert.equal(canStandOnTerrain(map,corrected.x,corrected.y),true);
});

test('actor markers reuse the quest book version instead of rescanning every quest',()=>{
  const isolated=structuredClone(campaign),quests=isolated.quests;
  let scans=0;
  Object.defineProperty(isolated,'quests',{configurable:true,get(){scans++;return quests;}});
  const session=new Session(isolated);
  session.accept('grafton-mission');
  assert.equal(session.markerActor('darius','npc-40'),true);
  const base=scans;
  session.markerActor('darius','npc-40');session.markerActor('darius','npc-40');
  assert.equal(scans,base,'任务簿版本不变时不再扫描任务表');
});

/** 创建一条一次性遭遇、记录它的怪物永久死亡，并结算。 */
function settleEncounter(session:Session,id:string,map:string):string{
  const enemyId='enemy-wild-wolf-1';
  session.applyStoryCommands([{type:'encounter',encounter:{id,map,status:'active',spawns:[{id:'mob',enemyId,x:128,y:128}]}}]);
  const key=encounterSpawnId(id,'mob');
  session.enemyDefeated({id:key,enemyId,x:128,y:128,respawn:false});
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id,result:'won'}}]);
  return key;
}

test('the encounter-result receipt restores both the world and the enemy states it pruned',()=>{
  const session=new Session(campaign),map=campaign.start.map;
  for(let index=0;index<64;index++)settleEncounter(session,`receipt-${index}`,map);
  const active='receipt-late';
  session.applyStoryCommands([{type:'encounter',encounter:{id:active,map,status:'active',spawns:[{id:'mob',enemyId:'enemy-wild-wolf-1',x:128,y:128}]}}]);
  const activeKey=encounterSpawnId(active,'mob');
  session.enemyDefeated({id:activeKey,enemyId:'enemy-wild-wolf-1',x:128,y:128,respawn:false});
  const before=session.captureState();
  const receipt=session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:active,result:'won'}}],undefined,{deferFinalize:true});
  assert.equal(session.storyWorld.encounter('receipt-0'),undefined,'新完成的一条把最旧历史挤出去');
  assert.deepEqual(session.enemyVitals(encounterSpawnId('receipt-0','mob')),{});
  receipt.rollback();
  assert.deepEqual(session.captureState(),before,'世界和敌人状态一起回到提交前');
  assert.equal(session.storyWorld.encounter('receipt-0')?.status,'won');
  assert.equal(session.enemyVitals(encounterSpawnId('receipt-0','mob')).deadUntil,'permanent');
});

test('loading a save keeps completed encounters and their enemy states as written',()=>{
  const session=new Session(campaign),map=campaign.start.map;
  const state=session.captureState();
  const completed=Array.from({length:66},(_,index)=>({
    id:`legacy-${index}`,map,status:'won' as const,spawns:[{id:'mob',enemyId:'enemy-wild-wolf-1',x:128,y:128}],
  }));
  state.storyWorld.encounters=[...completed,{id:'legacy-active',map,status:'active' as const,spawns:[]}];
  state.enemies=completed.map(encounter=>[encounterSpawnId(encounter.id,'mob'),{deadUntil:'permanent' as const}]);
  session.restoreState(state);
  assert.equal(session.storyWorld.encounter('legacy-0')?.status,'won');
  assert.equal(session.storyWorld.encounter('legacy-65')?.status,'won');
  assert.equal(session.storyWorld.encounter('legacy-active')?.status,'active');
  assert.equal(session.enemyVitals(encounterSpawnId('legacy-0','mob')).deadUntil,'permanent');
  assert.equal(session.enemyVitals(encounterSpawnId('legacy-65','mob')).deadUntil,'permanent');
  assert.equal(session.captureState().storyWorld.encounters.length,67);
});
