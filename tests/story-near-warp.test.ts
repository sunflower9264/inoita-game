import assert from 'node:assert/strict';
import test from 'node:test';
import {playthrough} from './helpers/story-playthrough.ts';

// These fixtures isolate lawful native entrance conditions; they do not prove a whole chapter playthrough.
test('NPC 611 in Berkel capital opens the memory hub through native event 560',async()=>{
  const h=playthrough();
  try{
    h.session.applyStoryCommands([{type:'travel',destination:{map:'berkel-capital',x:232,y:312,facing:'north'}}]);
    h.session.accept('quest-472');
    h.choices(['option-3']);
    await h.approach('npc-611');
    assert.equal(h.actions.find(action=>action.type==='stage')?.mapFromWorld,true,'fade before the warp stays in the entrance map');
    assert.equal(h.session.storyWorld.currentLocation?.map,'kiyan-s-memory-layer-1-631d46d8');
    assert.equal(h.session.status('quest-403'),'active');
    assert.ok(h.session.runtimeState.completedEvents.includes('event-560'));
  }finally{h.director.dispose();}
});

test('NPC 477 keeps the opening in the seal center and native event 401 warps to the boss room',async()=>{
  const h=playthrough();
  try{
    const runtime=h.session.runtimeState;
    runtime.completedEvents.push('event-400');h.session.runtimeState=runtime;
    h.session.applyStoryCommands([{type:'travel',destination:{map:'final-seal-s-center-93cc4231',x:200,y:232,facing:'north'}}]);
    await h.approach('npc-477');
    const stages=h.actions.filter(action=>action.type==='stage');
    assert.equal(stages[0]?.mapFromWorld,true,'pre-warp staging uses the captured current world');
    assert.equal(h.session.storyWorld.currentLocation?.map,'final-sealed-boss-room-0a1ba3bd');
    assert.equal(h.session.status('quest-345'),'active');
    assert.equal(h.director.runtime.snapshot().runs.find(run=>run.eventId==='event-401')?.status,'waiting');
    const encounter=h.session.storyWorld.captureState().encounters.find(encounter=>encounter.id.endsWith(':event-401-battle'));
    assert.ok(encounter);
    assert.equal(encounter.spawns.length,3);
  }finally{h.director.dispose();}
});
