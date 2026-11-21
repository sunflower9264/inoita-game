import assert from 'node:assert/strict';
import test from 'node:test';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { Session } from '../src/domain/session.ts';

test('哥布林监狱2的钥匙直接进入背包时，同图交付人立即出现', () => {
  const session = new Session(headlessContent.campaign);
  const map = 'goblin-prison-2-27ab25e1', characterId = 'npc-170';
  session.applyStoryCommands([{type:'travel',destination:{map,x:40,y:40,facing:'south'}}]);
  assert.ok(session.accept('quest-33'));
  session.applyStoryCommands([{type:'world',command:{kind:'remove-character',map,characterId,all:false}}]);
  assert.equal(session.storyWorld.actorVisible(map,characterId),false);
  session.bag.add('prison-key-2',1);
  session.emit();
  assert.equal(session.status('quest-33'),'ready');
  assert.equal(session.storyWorld.actorVisible(map,characterId),true);
});

test('取消让任务首次进入待交付的剧情时，恢复交付人原先的临时缺席', () => {
  const h = playthrough();
  try {
    const {session} = h, map = 'snow-fey-village-b6acd59c', id = 'npc-574';
    h.director.holdTriggers();
    session.applyStoryCommands([{type:'travel', destination:{map, x:552, y:528, facing:'north'}}]);
    assert.ok(session.accept('quest-351'));
    for (const enemy of ['enemy-frost-werewolf-1','enemy-iceshell-turtle-1']) session.recordQuestFact('defeat',enemy);
    session.applyStoryCommands([{type:'world', command:{kind:'remove-character', map, characterId:id, all:false}}]);
    assert.equal(session.storyWorld.actorVisible(map,id), false);
    const receipt = session.applyStoryCommands([{type:'quest', command:{type:'fact', fact:{
      kind:'defeat', target:'enemy-purification-cave-watcher-1', occurrence:{source:'last-enemy',sequence:1},
    }}}], undefined, {deferFinalize:true});
    assert.equal(session.status('quest-351'), 'ready');
    assert.equal(session.storyWorld.actorVisible(map,id), true);
    receipt.rollback();
    assert.equal(session.status('quest-351'), 'active');
    assert.equal(session.storyWorld.actorVisible(map,id), false);
  } finally { h.director.dispose(); }
});

test('a ready quest actor is restored after a story clears the map in the same visit', async () => {
  const h = playthrough();
  try {
    await h.idle();
    h.session.applyStoryCommands([{ type: 'travel', destination: { map: 'snow-fey-village-b6acd59c', x: 552, y: 528, facing: 'north' } }]);
    await h.idle();
    const arnold = h.entities().find(entity => entity.characterId === 'npc-574');
    assert.ok(arnold, '战前阿诺德在雪之精灵村');
    await h.director.interact(arnold, headlessContent.world.actors[arnold.actor]);
    await h.idle();
    // 把 quest-351 的目标全部记满，任务进入待交付。
    for (const target of ['enemy-frost-werewolf-1', 'enemy-iceshell-turtle-1', 'enemy-purification-cave-watcher-1'])
      h.session.recordQuestFact('defeat', target);
    h.session.emit(); await h.idle();
    assert.equal(h.session.status('quest-351'), 'ready');

    // 逐节点重放 event-316 的世界命令：战斗清场会 remove-character 阿诺德。
    for (const node of h.session.campaign.scripts['event-316'].nodes) {
      const world = (node.commands ?? []).filter(command => command.type === 'world');
      if (!world.length) continue;
      h.session.applyStoryCommands(world);
      h.session.emit(); await h.idle();
    }

    // 同一次进图里，待交付任务的交付人必须仍可交互；不能逼玩家离开再回来。
    const returned = h.entities().find(entity => entity.characterId === 'npc-574');
    assert.ok(returned, '清场后待交付任务的猎人要留在本图');
    assert.equal(h.session.npcQuestSlot('bounty-hunter-arnold-42fe291f', 'npc-574')?.id, 'quest-351');
    await h.director.interact(returned, headlessContent.world.actors[returned.actor]);
    await h.idle();
    assert.equal(h.session.status('quest-351'), 'completed');
    assert.deepEqual(h.popups.filter(value => value === 'complete:quest-351'), ['complete:quest-351']);
  } finally {
    h.director.dispose();
  }
});
