import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { StoryWorldState } from '../src/domain/story-world.ts';

const base:Campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8'));
const location=(map:string)=>({map,x:40,y:40,facing:'south' as const});
const place=(world:StoryWorldState,id:string,map='cave')=>world.apply({kind:'place',scope:'visit',entity:{id,map,actor:'rock',characterId:'npc-rock',x:8,y:40}});

test('visit objects survive same-map movement and current saves, then disappear on departure',()=>{
  const world=new StoryWorldState();world.apply({kind:'travel',destination:location('cave')});place(world,'left');place(world,'right');
  world.apply({kind:'travel',destination:{...location('cave'),x:56}});
  const saved=world.captureState(),restored=new StoryWorldState();restored.restoreState(saved);
  assert.equal(restored.projectEntities('cave',[]).length,2);
  restored.apply({kind:'travel',destination:location('forest')});
  restored.apply({kind:'travel',destination:location('cave')});
  assert.deepEqual(restored.projectEntities('cave',[]),[]);
});

test('objects prepared in the destination belong to that visit and remove-one preserves the other instance',()=>{
  const world=new StoryWorldState();world.apply({kind:'travel',destination:location('forest')});place(world,'first');place(world,'second');
  world.apply({kind:'travel',destination:location('cave')});
  world.apply({kind:'remove-character',map:'cave',characterId:'npc-rock',all:false});
  assert.deepEqual(world.projectEntities('cave',[]).map(entity=>entity.id),['second']);
  world.apply({kind:'remove-character',map:'cave',characterId:'npc-rock',all:true});
  assert.deepEqual(world.projectEntities('cave',[]),[]);
});

test('remove-character also hides a static map placement through the absent flag',()=>{
  const world=new StoryWorldState();
  world.apply({kind:'travel',destination:location('cave')});
  assert.equal(world.actorVisible('cave','barricade-a1eb664e','npc-120'),true);
  world.apply({kind:'remove-character',map:'cave',characterId:'npc-120',all:false});
  assert.equal(world.actorVisible('cave','barricade-a1eb664e','npc-120'),false,'静态摆放也要按本图缺少角色处理');
  assert.equal(world.actorVisible('forest','barricade-a1eb664e','npc-120'),true,'只影响命令指定的地图');
});

test('story presentation keeps the ending narration and omits tutorial tips',()=>{
  const tips=Object.values(base.scripts).flatMap(script=>script.nodes.flatMap(node=>node.presentation)).filter(action=>action.type==='instant-message');
  assert.deepEqual(tips.map(action=>action.text),[
    '祝贺你安全回到了现实世界！','你已经完成了艾诺迪亚4的所有剧情。','后续的故事，请期待下一部作品^^'
  ]);
});

test('a scene object without an authored map uses the actual playback map',async()=>{
  const campaign:Campaign={...base,scripts:{demo:{entry:'place',nodes:[{id:'place',presentation:[],commands:[
    {type:'world',command:{kind:'place',mapFromStage:true,scope:'visit',entity:{id:'rock',map:'preview-map',actor:'rock',x:8,y:40}}}
  ],exit:{type:'end'}}]}},events:[{id:'demo',script:'demo',source:'start'}]};
  const session=new Session(campaign);session.applyStoryCommands([{type:'travel',destination:location('actual-map')}]);
  const ui:StoryUI={async dialogue(){},async choice(){throw new Error('unused');},async questPopup(){},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(campaign,session,ui,()=>{});
  await director.start();assert.equal(session.storyWorld.entity('rock')?.map,'actual-map');director.dispose();
});
