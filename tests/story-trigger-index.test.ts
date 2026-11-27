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

test('另外四类封印祭坛也只在自己的洞穴触发', () => {
  const story: StoryGraph = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const groups = [
    ['npc-484', 'sealed-altar-40c37439', {
      'sealed-room-east-eeb848fc': 'event-392',
      'eternal-world-3-9676ac48': 'event-459',
      'mist-village-deserted-house-2-cfd8b6d3': 'event-573',
    }],
    ['npc-485', 'sealed-altar-d775d77f', {
      'sealed-room-south-52aee6b4': 'event-393',
      'dark-woods-3-2bda69eb': 'event-460',
      'mist-village-deserted-house-2-cfd8b6d3': 'event-574',
    }],
    ['npc-486', 'sealed-altar-b6f9cbc1', {
      'sealed-room-west-a0be4dae': 'event-394',
      'goblin-s-lair-3-c47d6e5f': 'event-461',
      'mist-village-deserted-house-2-cfd8b6d3': 'event-575',
    }],
    ['npc-487', 'sealed-altar-4bc5d7a9', {
      'sealed-room-north-83f01435': 'event-395',
      'abandoned-mines-3-219fbb39': 'event-482',
      'mist-village-deserted-house-2-cfd8b6d3': 'event-576',
    }],
  ] as const;
  for (const [characterId, actor, byMap] of groups) {
    const altar = character('altar', actor, characterId);
    for (const [map, expected] of Object.entries(byMap)) {
      const { nearCharacters } = buildStoryTriggerIndex(story, map, [altar]);
      assert.deepEqual(nearCharacters.flatMap(group => group.events.map(event => event.id)), [expected],
        `${characterId} 在 ${map} 只应触发 ${expected}`);
    }
  }
});

test('现世与深渊机关室的共用触发机关（trigger-cb2455aa）只在各自所在地图触发对应剧情', () => {
  const story: StoryGraph = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const trigger = character('trigger', 'trigger-cb2455aa', 'npc-94');
  for (const [map, mustInclude, mustExclude] of [
    ['engine-room-of-reality-a06620c7', 'event-321', 'event-326'],
    ['abyss-engine-room-be5a127f', 'event-326', 'event-321'],
    ['sealed-dungeon-1-2-c824bb14', undefined, 'event-321'],
    ['inside-arnen-castle02-9a1430d7', undefined, 'event-326'],
  ] as const) {
    const ids = buildStoryTriggerIndex(story, map, [trigger]).nearCharacters.flatMap(group => group.events.map(ev => ev.id));
    if (mustInclude) assert.ok(ids.includes(mustInclude), `${map} 应包含 ${mustInclude}`);
    assert.equal(ids.includes(mustExclude), false, `${map} 不应包含 ${mustExclude}`);
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

test('正式剧情中共用开关、铁门、木栅栏与次元之门的近身事件均已限定所属地图，不会跨图串入触发索引', () => {
  const story: StoryGraph = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const checks = [
    { actor: 'switch-6d46d3c1', charId: 'npc-241', map: 'goblin-s-lair-2-49c1710f', include: 'event-36', exclude: 'event-243' },
    { actor: 'switch-6d46d3c1', charId: 'npc-241', map: 'blackhoods-stronghold-2-4dc049d1', include: 'event-243', exclude: 'event-36' },
    { actor: 'barricade-a1eb664e', charId: 'npc-120', map: 'sealed-dungeon-1-1-78024c9d', include: 'event-351', exclude: 'event-246' },
    { actor: 'barricade-a1eb664e', charId: 'npc-120', map: 'berkel-capital', include: undefined, exclude: 'event-351' },
    { actor: 'leap-gate-253891b2', charId: 'npc-111', map: 'leap-gate-district-1da2f793', include: 'event-189', exclude: undefined },
    { actor: 'leap-gate-253891b2', charId: 'npc-111', map: 'old-sanctuary-54cffd62', include: undefined, exclude: 'event-189' },
    { actor: 'steel-door-430a2b1b', charId: 'npc-320', map: 'kiyan-s-final-memory-layer-2-ecc3d1ca', include: 'event-563', exclude: undefined },
    { actor: 'steel-door-430a2b1b', charId: 'npc-320', map: 'fort-of-screams-floor-3-c78c50b3', include: undefined, exclude: 'event-563' },
  ] as const;
  for (const c of checks) {
    const ids = buildStoryTriggerIndex(story, c.map, [character('e', c.actor, c.charId)]).nearCharacters.flatMap(g => g.events.map(ev => ev.id));
    if (c.include) assert.ok(ids.includes(c.include), `${c.map} 应包含 ${c.include}`);
    if (c.exclude) assert.equal(ids.includes(c.exclude), false, `${c.map} 不应串入其他地图的 ${c.exclude}`);
  }
});
