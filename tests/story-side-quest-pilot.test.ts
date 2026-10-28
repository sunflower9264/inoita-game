import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareTaskStart} from '../src/debug/story-jump.ts';
import {headlessContent,playthrough} from './helpers/story-playthrough.ts';

test('an active side quest can defeat its target and be handed in on the real scene path', async () => {
  const base=playthrough();
  const task=base.session.campaign.debugStory!.tasks.find(candidate=>candidate.quest==='quest-133');
  assert.ok(task,'quest-133 调试现场');
  const prepared=await prepareTaskStart(base.session,{quest:task.quest});
  base.director.dispose();
  const h=playthrough(prepared);
  try {
    assert.equal(h.session.status('quest-133'),'active');
    const travelTo=async(map:string,x:number,y:number)=>{
      h.session.applyStoryCommands([{type:'travel',destination:{map,x,y,facing:'south'}}]);
      await h.idle();
    };
    await travelTo('fort-of-screams-floor-1-c9fd5293',424,120);
    await h.defeat('enemy-mutinous-benukes-1');
    assert.equal(h.session.status('quest-133'),'ready','击败目标后任务应可交付');
    await travelTo('steel-orc-village-57c67f8c',392,312);
    const giver=h.entities().find(entity=>entity.characterId==='npc-283');
    assert.ok(giver,'回到发布人地图');
    await h.director.interact(giver,headlessContent.world.actors[giver.actor]);
    await h.idle();
    assert.equal(h.session.status('quest-133'),'completed','回到发布人处交任务应完成');
  } finally {
    h.director.dispose();
  }
});
