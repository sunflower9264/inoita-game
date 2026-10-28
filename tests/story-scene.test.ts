import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {SceneActorState,SceneSnapshot} from '../src/domain/scene-snapshot.ts';
import type {PerformanceAction,StoryCastMember,StoryStage} from '../src/domain/story-performance.ts';
import {applyStorySceneAction,boundSceneActor,findSceneActor,hideUnboundCombatActors,resolveStoryScene,syncStoryScene} from '../src/domain/story-scene.ts';

const actor=(id:string,extra:Partial<SceneActorState>={}):SceneActorState=>({id,actor:id,x:10,y:20,facing:'south',visible:true,...extra});
const member=(id:string,extra:Partial<StoryCastMember>={}):StoryCastMember=>({id,actor:id,x:0,y:0,facing:'south',visible:false,binding:'world',...extra});
const stage=(cast:StoryCastMember[]=[]):StoryStage=>({type:'stage',map:'camp',x:1,y:2,facing:'east',playerVisible:true,retainPlayerPosition:true,cast});
const source=(actors:SceneActorState[]=[]):SceneSnapshot=>({map:'camp',actors:[actor('player'),...actors]});

test('scene takeover preserves every non-script object and binds aliases to the existing instance',()=>{
  const original=source([
    actor('entity:gate',{actor:'gate',worldEntityId:'gate',characterId:'gate-character'}),
    actor('entity:opened-chest',{actor:'chest',worldEntityId:'opened-chest',visible:false}),
    actor('entity:spring',{actor:'spring',worldEntityId:'spring'}),
    actor('member:ally',{actor:'ally',memberId:'ally'}),
    actor('enemy:one',{actor:'wolf',enemyId:'wolf',enemyKey:'one'}),
    actor('enemy:two',{actor:'wolf',enemyId:'wolf',enemyKey:'two'}),
    actor('enemy:summon',{actor:'wolf',enemyId:'wolf',enemyKey:'summon',summonedBy:'ally'})
  ]);
  const before=structuredClone(original);
  const snapshot=resolveStoryScene(stage([member('script-gate',{actor:'gate',characterId:'gate-character'})]),original);
  assert.deepEqual(snapshot.scene,original);
  assert.equal(boundSceneActor(snapshot,'script-gate')?.id,'entity:gate');
  assert.equal(snapshot.cast[0]?.visible,true,'a declared hidden lookup must preserve actual existing visibility');
  assert.deepEqual([snapshot.x,snapshot.y,snapshot.facing],[10,20,'south']);
  applyStorySceneAction(snapshot,{type:'leave',target:'script-gate'});
  assert.deepEqual(original,before,'render actions must not mutate the source or previous stable node');
});

test('missing lookup stays offstage through face/walk/show until an explicit appearance, including ensure',()=>{
  let snapshot=resolveStoryScene(stage([member('missing',{characterId:'missing-character'})]),source());
  const missing=()=>boundSceneActor(snapshot,'missing')!;
  assert.equal(missing().unpositioned,true);
  for(const action of [
    {type:'walk',target:'missing',x:100,y:200,speedPxPerSecond:10},
    {type:'walk',target:'missing',x:100,y:200,speedPxPerSecond:10,ensure:true},
    {type:'face',target:'missing',facing:'north',ensure:true},
    {type:'show',target:'missing'}
  ] as PerformanceAction[]){snapshot=applyStorySceneAction(snapshot,action);assert.equal(missing().visible,false);}
  assert.deepEqual([missing().x,missing().y],[2048,2048]);
  snapshot=applyStorySceneAction(snapshot,{type:'appear',target:'missing',x:100,y:200,facing:'west'});
  assert.deepEqual([missing().x,missing().y,missing().visible,missing().unpositioned],[100,200,true,false]);
});

test('reuse preserves canonical instance and real outfit while explicit create keeps repeated actors distinct',()=>{
  const appearance={id:'soldier',clips:{},name:'soldier',description:'',portrait:null} satisfies ActorDefinition;
  let snapshot=resolveStoryScene(stage([member('soldier',{characterId:'soldier-character'})]),source([
    actor('entity:original',{actor:'soldier',characterId:'soldier-character',worldEntityId:'original',appearance})
  ]));
  snapshot=applyStorySceneAction(snapshot,{type:'world-object',target:'soldier',mode:'reuse',command:{kind:'place',entity:{
    id:'registered',actor:'soldier',characterId:'soldier-character',map:'camp',x:30,y:40}}});
  assert.equal(boundSceneActor(snapshot,'soldier')?.id,'entity:original');
  assert.equal(boundSceneActor(snapshot,'soldier')?.worldEntityId,'registered');
  assert.deepEqual(boundSceneActor(snapshot,'soldier')?.appearance,appearance);
  snapshot=applyStorySceneAction(snapshot,{type:'appear',target:'soldier',mode:'create',x:50,y:60,facing:'north'});
  const first=boundSceneActor(snapshot,'soldier')!;
  snapshot=applyStorySceneAction(snapshot,{type:'appear',target:'soldier',mode:'create',x:70,y:80,facing:'east'});
  assert.notEqual(boundSceneActor(snapshot,'soldier')!.id,first.id);
  assert.equal(snapshot.scene.actors.filter(actor=>actor.characterId==='soldier-character'&&actor.visible).length,3);
  assert.equal(boundSceneActor(snapshot,'soldier')!.worldEntityId,undefined);
});

test('delayed object placement and sequential removals update the roster at the action boundary',()=>{
  let snapshot=resolveStoryScene(stage([member('fire',{actor:'campfire',characterId:'fire-character'})]),source());
  assert.equal(boundSceneActor(snapshot,'fire')?.visible,false);
  snapshot=applyStorySceneAction(snapshot,{type:'wait',durationMs:100});
  assert.equal(boundSceneActor(snapshot,'fire')?.visible,false);
  for(const id of ['fire-one','fire-two'])snapshot=applyStorySceneAction(snapshot,{type:'world-object',target:'fire',mode:'create',
    command:{kind:'place',entity:{id,map:'camp',actor:'campfire',characterId:'fire-character',x:30,y:40}}});
  const remove:PerformanceAction={type:'world-object',command:{kind:'remove-character',characterId:'fire-character',map:'camp',all:false}};
  snapshot=applyStorySceneAction(snapshot,remove);
  assert.equal(snapshot.scene.actors.filter(actor=>actor.characterId==='fire-character'&&actor.visible).length,1);
  snapshot=applyStorySceneAction(snapshot,remove);
  assert.equal(snapshot.scene.actors.filter(actor=>actor.characterId==='fire-character'&&actor.visible).length,0);
  assert.equal(snapshot.scene.actors.filter(actor=>actor.removed).length,2);
  assert.equal(findSceneActor(snapshot.scene,member('lookup',{characterId:'fire-character'}))?.unpositioned,true);
});

test('snapshot synchronization follows aliases, final walking direction and parallel actions',()=>{
  let snapshot=resolveStoryScene(stage([member('npc',{actor:'npc',characterId:'npc-character'})]),source([
    actor('entity:npc',{actor:'npc',characterId:'npc-character',worldEntityId:'npc',x:10,y:20})
  ]));
  snapshot=applyStorySceneAction(snapshot,{type:'parallel',actions:[
    {type:'walk',target:'npc',x:30,y:20,speedPxPerSecond:10},
    {type:'walk',target:'player',x:10,y:40,speedPxPerSecond:10}
  ]});
  assert.deepEqual([snapshot.cast[0]!.x,snapshot.cast[0]!.y,snapshot.cast[0]!.facing],[30,20,'east']);
  assert.deepEqual([snapshot.x,snapshot.y,snapshot.facing],[10,40,'south']);
  snapshot.scene.actors.find(actor=>actor.id==='entity:npc')!.x=99;
  syncStoryScene(snapshot);assert.equal(snapshot.cast[0]!.x,99);
  assert.throws(()=>applyStorySceneAction(snapshot,{type:'show',target:'undeclared'}),/没有声明对象/);
});

test('a temporary performer sharing an appearance cannot take over an explicitly bound world entity',()=>{
  const snapshot=resolveStoryScene(stage([
    member('named-performer',{actor:'guard',worldEntityId:'persistent-guard',binding:undefined,x:60,y:70,visible:true}),
    member('temporary-double',{actor:'guard',binding:undefined,x:80,y:90,visible:true})
  ]),source([actor('entity:persistent-guard',{actor:'guard',worldEntityId:'persistent-guard'})]));
  const persistent=boundSceneActor(snapshot,'named-performer')!,temporary=boundSceneActor(snapshot,'temporary-double')!;
  assert.notEqual(persistent.id,temporary.id);
  assert.deepEqual([persistent.x,persistent.y],[60,70]);
  assert.deepEqual([temporary.x,temporary.y],[80,90]);
  assert.equal(temporary.worldEntityId,undefined);
});

test('unbound combat actors stay in the world instead of appearing in the story stage',()=>{
  const enemy=actor('enemy:shin',{actor:'enemy-shin-1',enemyId:'enemy-shin-1',enemyKey:'encounter',x:139,y:152,visible:true});
  const snapshot=resolveStoryScene(stage([member('shinty',{actor:'shinty',characterId:'npc-56',binding:undefined,x:168,y:168,visible:true})]),source([enemy]));
  hideUnboundCombatActors(snapshot);
  assert.equal(snapshot.scene.actors.find(candidate=>candidate.enemyKey==='encounter')!.visible,false);
  assert.equal(boundSceneActor(snapshot,'shinty')!.visible,true);
});
test('a combat actor explicitly named by the current cast stays visible',()=>{
  const enemy=actor('enemy:shin',{actor:'enemy-shin-1',enemyId:'enemy-shin-1',enemyKey:'encounter',x:139,y:152,visible:true});
  const snapshot=resolveStoryScene(stage([member('shin',{actor:'enemy-shin-1',enemyId:'enemy-shin-1',binding:undefined,x:139,y:152,visible:true})]),source([enemy]));
  hideUnboundCombatActors(snapshot);
  assert.equal(boundSceneActor(snapshot,'shin')!.visible,true);
});
test('an unbound friendly summon remains part of the party scene',()=>{
  const summon=actor('enemy:summon',{actor:'hell-soldier',enemyId:'enemy-hell-s-pawn-1',enemyKey:'summon',summonedBy:'player',x:20,y:20,visible:true});
  const snapshot=resolveStoryScene(stage(),source([summon]));
  hideUnboundCombatActors(snapshot);
  assert.equal(snapshot.scene.actors.find(candidate=>candidate.enemyKey==='summon')!.visible,true);
});

test('appearance instance IDs survive action replay and keep distinct created identities',()=>{
  let snapshot=resolveStoryScene(stage([member('goblin',{actor:'goblin',characterId:'goblin-character'})]),source());
  const first:PerformanceAction={type:'appear',target:'goblin',mode:'create',worldEntityId:'spawn-one',x:30,y:40,facing:'east'};
  snapshot=applyStorySceneAction(snapshot,first);
  const id=boundSceneActor(snapshot,'goblin')!.id;
  snapshot=applyStorySceneAction(snapshot,first);
  assert.equal(boundSceneActor(snapshot,'goblin')!.id,id);
  assert.equal(snapshot.scene.actors.filter(actor=>actor.worldEntityId==='spawn-one').length,1);
  snapshot=applyStorySceneAction(snapshot,{...first,worldEntityId:'spawn-two',x:50});
  assert.equal(snapshot.scene.actors.filter(actor=>actor.visible&&actor.characterId==='goblin-character').length,2);
  assert.equal(boundSceneActor(snapshot,'goblin')!.worldEntityId,'spawn-two');
});

test('pose reduction preserves a held last frame and resumes idle for a non-held pose',()=>{
  let snapshot=resolveStoryScene(stage(),source());
  snapshot=applyStorySceneAction(snapshot,{type:'pose',target:'player',pose:'attack',durationMs:100,hold:true});
  let player=boundSceneActor(snapshot,'player')!;
  assert.deepEqual([player.clip,player.animationProgress,player.animationPlaying],['attack-south',1,false]);
  const faced=applyStorySceneAction(snapshot,{type:'face',target:'player',facing:'east'});
  const turned=boundSceneActor(faced,'player')!;
  assert.deepEqual([turned.clip,turned.animationProgress,turned.animationPlaying],['idle-east',0,true]);
  snapshot=applyStorySceneAction(snapshot,{type:'pose',target:'player',pose:'attack',durationMs:100});
  player=boundSceneActor(snapshot,'player')!;
  assert.deepEqual([player.clip,player.animationProgress,player.animationPlaying],['idle-south',0,true]);
});

test('an ambiguous character number fails instead of taking the first matching actor',()=>{
  const snapshot=source([
    actor('entity:left',{actor:'guard',characterId:'guard-character',worldEntityId:'left',x:20,y:20}),
    actor('entity:right',{actor:'guard',characterId:'guard-character',worldEntityId:'right',x:200,y:200}),
  ]);
  assert.throws(()=>resolveStoryScene(stage([
    member('guard',{characterId:'guard-character',x:2048,y:2048}),
  ]),snapshot),/剧情演员来源不唯一.*guard-character.*left.*right/);
});

test('a positioned declaration picks the uniquely nearest candidate',()=>{
  const snapshot=resolveStoryScene(stage([
    member('guard',{characterId:'guard-character',binding:undefined,x:22,y:20,visible:true}),
  ]),source([
    actor('entity:left',{actor:'guard',characterId:'guard-character',worldEntityId:'left',x:20,y:20}),
    actor('entity:right',{actor:'guard',characterId:'guard-character',worldEntityId:'right',x:200,y:200}),
  ]));
  assert.equal(boundSceneActor(snapshot,'guard')?.id,'entity:left');
});

test('two aliases cannot resolve to one actor and silently draw one of them twice',()=>{
  assert.throws(()=>resolveStoryScene(stage([
    member('first',{characterId:'guard-character'}),
    member('second',{characterId:'guard-character'}),
  ]),source([
    actor('entity:guard',{actor:'guard',characterId:'guard-character',worldEntityId:'guard'}),
  ])),/剧情演员重复绑定/);
});

test('a party member named together with its map copy leaves only the party instance visible',()=>{
  const snapshot=resolveStoryScene(stage([
    member('story-olaf',{actor:'olaf',memberId:'story-mercenary-olaf',characterId:'npc-249',x:40,y:50,visible:true}),
  ]),source([
    actor('member:story-mercenary-olaf',{actor:'olaf',memberId:'story-mercenary-olaf',x:40,y:50}),
    actor('entity:story-character-npc-249',{actor:'olaf',characterId:'npc-249',worldEntityId:'story-character-npc-249',x:40,y:50}),
  ]));
  const party=snapshot.scene.actors.find(candidate=>candidate.memberId==='story-mercenary-olaf')!;
  const worldCopy=snapshot.scene.actors.find(candidate=>candidate.worldEntityId==='story-character-npc-249')!;
  assert.equal(party.visible,true);
  assert.equal(worldCopy.visible,false);
  assert.equal(worldCopy.stageHidden,true);
});

test('a companion alias before joining does not hide the map NPC',()=>{
  const snapshot=resolveStoryScene(stage([
    member('story-olaf',{actor:'olaf',memberId:'story-mercenary-olaf',characterId:'npc-249',x:40,y:50,visible:true}),
  ]),source([
    actor('entity:story-character-npc-249',{actor:'olaf',characterId:'npc-249',worldEntityId:'story-character-npc-249',x:40,y:50}),
  ]));
  const worldCopy=snapshot.scene.actors.find(candidate=>candidate.worldEntityId==='story-character-npc-249')!;
  assert.equal(worldCopy.visible,true,'尚未入队时地图上的 NPC 仍应显示');
  assert.notEqual(worldCopy.stageHidden,true);
});

test('an unpositioned hidden template does not steal one of several matching map actors',()=>{
  const snapshot=resolveStoryScene(stage([
    member('template',{actor:'boulder',characterId:'boulder-character',unpositioned:true,visible:false,x:2048,y:2048}),
  ]),source([
    actor('entity:first',{actor:'boulder',characterId:'boulder-character',worldEntityId:'first'}),
    actor('entity:second',{actor:'boulder',characterId:'boulder-character',worldEntityId:'second'}),
  ]));
  const template=boundSceneActor(snapshot,'template')!;
  assert.equal(template.unpositioned,true);
  assert.notEqual(template.id,'entity:first');
  assert.notEqual(template.id,'entity:second');
});

test('a registered location wins over the older static copy of the same character',()=>{
  const snapshot=resolveStoryScene(stage([
    member('boulder',{actor:'boulder',characterId:'npc-100',x:520,y:88}),
  ]),source([
    actor('entity:boulder2-static',{actor:'boulder',characterId:'npc-100',worldEntityId:'boulder2-static',x:504,y:72}),
    actor('entity:quest-npc-located-npc-100',{actor:'boulder',characterId:'npc-100',worldEntityId:'quest-npc-located-npc-100',x:520,y:88}),
  ]));
  const registered=snapshot.scene.actors.find(candidate=>candidate.worldEntityId==='quest-npc-located-npc-100')!;
  const stale=snapshot.scene.actors.find(candidate=>candidate.worldEntityId==='boulder2-static')!;
  assert.equal(boundSceneActor(snapshot,'boulder')?.id,registered.id);
  assert.equal(registered.visible,true);
  assert.equal(stale.visible,false);
  assert.equal(stale.stageHidden,true);
});
