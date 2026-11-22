import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { StoryCommand } from '../src/domain/story-graph.ts';

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../public/content/${file}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items'), battle = read<BattleCatalog>('battle'), stats = read<CharacterStatsCatalog>('character-stats'), companions = read<CompanionCatalog>('companions');
function quest(id: string, patch: Partial<CampaignQuest> = {}): CampaignQuest {
  return { id, title: id, description: id, giver: 'npc', guidance: { available: 'offer', active: 'continue' }, goals: [], completion: 'talk',
    progressText: 'continue', completeText: 'thanks', ...patch };
}
function campaignOf(quests: CampaignQuest[]): Campaign {
  return { version: 2, contentVersion: 1, start: { map: 'camp', actor: 'player', x: 16, y: 16, facing: 'south', script: 'opening' }, quests, placements: [], questGroups: [], events: [],
    scripts: { opening: { entry: 'entry', nodes: [{ id: 'entry', presentation: [], commands: [], exit: { type: 'end' } }] } } };
}
function fixture(quests: CampaignQuest[]) {
  const hero = new BattleCharacter('dark-knight', stats, items);
  const session = new Session(campaignOf(quests), undefined, undefined, items, hero, battle, stats, companions);
  // 预演沙盒是隔离的：命令不该在真实对象上留下任何痕迹。非任务模块逐字节对照即可证明这一点。
  const snapshot = () => ({ world: session.storyWorld.captureState(), loot: groundLootFor(session).captureState(),
    bag: session.bag.captureState(), hero: hero.captureState(), party: session.party?.captureState(), money: session.money });
  return { session, hero, snapshot };
}

test('a quest-only batch leaves the world, loot, bag, hero, party and coins untouched', () => {
  const { session, snapshot } = fixture([quest('hunt', { completion: 'all', goals: [{ id: 'g', kind: 'defeat', target: 'wolf', quantity: 2 }] })]);
  session.accept('hunt');
  const before = snapshot();
  session.recordQuestFact('defeat', 'wolf', 'combat');
  assert.equal(session.questBook.state('hunt')!.goals.g, 1);   // 事实确实记进了任务
  assert.deepEqual(snapshot(), before);
});

test('a batch keeps the real stores untouched when a later quest command cannot be planned', () => {
  const { session, snapshot } = fixture([
    quest('locked-one', { availableWhen: { type: 'flag', flag: 'never' } }),
    quest('ready-one', { completion: 'all', goals: [{ id: 'g', kind: 'item', target: 'healing-potion-s', quantity: 1 }],
      handoverItems: [{ item: 'healing-potion-s', quantity: 1 }] }),
  ]);
  const before = snapshot();
  const batches: StoryCommand[][] = [
    [{ type: 'item-give', item: 'healing-potion-s', quantity: 1 }, { type: 'quest', command: { type: 'accept', quest: 'locked-one' } }],
    [{ type: 'quest', command: { type: 'accept', quest: 'locked-one' } }, { type: 'item-give', item: 'healing-potion-s', quantity: 1 }],
    // 交付物品不足只在规划期暴露，整批也不能落地。
    [{ type: 'item-give', item: 'healing-potion-s', quantity: 1 }, { type: 'quest', command: { type: 'complete', quest: 'ready-one', cycle: 0 } }],
  ];
  for (const batch of batches) {
    assert.throws(() => session.applyStoryCommands(batch));
    assert.deepEqual(snapshot(), before);
    assert.equal(session.status('locked-one'), 'locked');
  }
});

test('a failed story batch that joins a companion leaves the real bag and party alone', () => {
  // `party-join` 会经由 `PartyRoster.create` 往背包里放起始装备——这条间接写路径正是
  // 「按命令类型挑沙盒」的做法最容易漏掉的地方。失败整批不能留下半套装备或队员。
  const { session, snapshot } = fixture([quest('locked-one', { availableWhen: { type: 'flag', flag: 'never' } })]);
  assert.ok(session.party);
  const before = snapshot();
  assert.throws(() => session.applyStoryCommands([
    { type: 'party-join', companion: 'mercenary-black-knight' },
    { type: 'quest', command: { type: 'accept', quest: 'locked-one' } },
  ]));
  assert.deepEqual(snapshot(), before);
});

test('one defeat does not run a second quest plan for the notification it publishes', (t) => {
  // 提交命令时只规划一次；提交后紧跟的 `emit → refresh` 复用已认领的投影，不再规划。
  const { session } = fixture([quest('hunt', { completion: 'all', goals: [{ id: 'g', kind: 'defeat', target: 'wolf', quantity: 2 }] })]);
  session.accept('hunt');
  let plans = 0;
  const original = session.questBook.plan.bind(session.questBook);
  t.mock.method(session.questBook, 'plan', (command: Parameters<typeof original>[0]) => { plans++; return original(command); });
  session.enemyDefeated({ id: 'wolf-1', enemyId: 'wolf', x: 0, y: 0 });
  assert.equal(plans, 1, '提交击杀事实时规划一次，通知刷新不重复规划');
  assert.equal(session.questBook.state('hunt')!.goals.g, 1);
  // 真的改了任务输入时仍然要重算：认领的投影是缓存，不是一次性结论。
  session.bag.add('healing-potion-s', 1);
  session.emit();
  assert.equal(plans, 1);
});

test('movePlayer writes the same world state as a travel command batch', () => {
  // 逐步走位不再走整批剧情命令，但落点簿记必须是同一段：跨图仍只走剧情转场命令。
  const destination = { map: 'camp', x: 48, y: 32, facing: 'east' } as const;
  const viaBatch = fixture([quest('first')]);
  viaBatch.session.applyStoryCommands([{ type: 'travel', destination: { ...destination } }]);
  const viaMove = fixture([quest('first')]);
  assert.equal(viaMove.session.movePlayer({ ...destination }), true);
  assert.deepEqual(viaMove.session.storyWorld.captureState(), viaBatch.session.storyWorld.captureState());
  // 同图内再挪一步：mapVisit 不变，visit 作用域的实体不会被清掉。
  const visit = viaMove.session.storyWorld.visit;
  viaMove.session.movePlayer({ ...destination, x: 64 });
  assert.equal(viaMove.session.storyWorld.visit, visit);
  assert.equal(viaMove.session.movePlayer({ ...destination, x: 64 }), false, '位置没变就不再上报');
  assert.throws(() => viaMove.session.movePlayer({ ...destination, map: 'elsewhere' }), /换图/);
});
