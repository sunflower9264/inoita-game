import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {buildStoryTriggerIndex} from '../src/domain/story-trigger-index.ts';
import type {StoryEvent, StoryGraph} from '../src/domain/story-graph.ts';

const event=(id:string,extra:Partial<StoryEvent>)=>({id,...extra}) as StoryEvent;
const campaign={events:[
  event('region-a',{source:'region',map:'a',region:{x:0,y:0,width:16,height:16}}),
  event('region-b',{source:'region',map:'b',region:{x:0,y:0,width:16,height:16}}),
  event('near-free',{source:'near',near:'npc'}),
  event('near-a',{source:'near',near:'npc',map:'a',nearCharacterId:'npc-2'}),
  event('near-b',{source:'near',near:'npc',map:'b'}),
  event('other',{source:'event'}),
]} as unknown as StoryGraph;

const character=(id:string,actor:string,characterId?:string,visible=true)=>({
  entity:{id,actor,characterId},container:{visible},
});

test('每个封印祭坛只办理自己所在洞穴的剧情', () => {
  const story: StoryGraph = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const altar = character('altar', 'sealed-altar-5a136b94', 'npc-477');
  for (const [map, expected] of [
    ['sealed-dungeon-1-3-3275afd4', 'event-373'],
    ['sealed-dungeon-2-3-cdbbbb1d', 'event-377'],
    ['final-seal-s-center-93cc4231', 'event-401'],
    ['sealed-dungeon-3-3-11ff2101', undefined],
  ] as const) {
    const { nearCharacters } = buildStoryTriggerIndex(story, map, [altar]);
    assert.deepEqual(nearCharacters.flatMap(group => group.events.map(event => event.id)), expected ? [expected] : []);
  }
});

test('trigger index groups the current map and preserves campaign order',()=>{
  const first=character('npc-1','npc'), second=character('npc-2','npc','npc-2'), hidden=character('npc-3','npc',undefined,false);
  const index=buildStoryTriggerIndex(campaign,'a',[first,second,hidden]);
  assert.deepEqual(index.regionEvents.map(value=>value.id),['region-a']);
  assert.deepEqual(index.nearCharacters.map(group => group.character), [first,second,hidden]);
  assert.deepEqual(index.nearCharacters.map(group => group.events.map(event => event.id)), [
    ['near-free'], ['near-free','near-a'], ['near-free'],
  ]);
});
