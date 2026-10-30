import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { storyConditionReferences } from '../src/domain/story-condition.ts';
import type { Campaign, CampaignPlacement, CampaignQuest } from '../src/domain/campaign.ts';
import type { ActorDefinition, EntityPlacement } from '../src/domain/content.ts';

/**
 * 「去跟某个 NPC 说话」「去对某个东西用一次」这两类任务目标的玩家侧通路：
 * 场景里的交互入口 → `StoryDirector.interact` → `Session.interact` → 任务目标计数。
 * 用真实内容驱动，避免用例写死某条任务的 id。
 */
const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), world = parseWorld(read('world'));

function harness() {
  const session = new Session(campaign), lines: string[] = [];
  const ui: StoryUI = {
    async dialogue(line) { lines.push(line.text); },
    async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, closeDialogue() {}, skipDialogue() {}, toast() {}
  };
  const director = new StoryDirector(campaign, session, ui, () => {}, { begin() {}, async execute() {}, async finish() {} });
  return { session, director, lines };
}
/** 一条「目标就是发布者本人」的任务：发布者流程与目标记账会落在同一次交互里。 */
/** 一条目标指向别的 NPC 的任务：发布者不在身边，只能靠场景交互推进。 */
function elsewhereTargetQuest(kind: 'talk' | 'interact') {
  return targetPair(kind, (quest, target) => target !== quest.giver, '目标指向别的 NPC');
}
/**
 * 摆放点自己声明了 `objective` 的走既有那条路，这里只找靠 actor 匹配的。
 *
 * 一个任务可以有多个同类目标（#86「艾泽林的家属」要两个孩子都问过），所以返回**全部**该类
 * 目标与它们各自的摆放点，用例逐个交互、只在最后一个之后要求整条任务达成。前置链浅的任务
 * 会被优先选中，用例可以直接接取；需要前置的先 `admit` 把前置接上。
 */
function targetPair(kind: 'talk' | 'interact', pick: (quest: CampaignQuest, target: string) => boolean,
  description: string): { quest: CampaignQuest; goals: CampaignQuest['goals']; placements: CampaignPlacement[]; prerequisites: CampaignQuest[] } {
  for (const quest of campaign.quests) {
    const goals = quest.goals.filter(goal => goal.kind === kind);
    if (!goals.length || !goals.every(goal => pick(quest, goal.target))) continue;
    const placements = goals.map(goal => campaign.placements.find(candidate => candidate.actor === goal.target && !candidate.objective));
    if (placements.some(placement => !placement)) continue;
    const prerequisites = [...storyConditionReferences(quest.availableWhen).quests]
      .map(id => campaign.quests.find(candidate => candidate.id === id)).filter((entry): entry is CampaignQuest => !!entry);
    if (prerequisites.some(entry => storyConditionReferences(entry.availableWhen).quests.size)) continue;
    return { quest, goals, placements: placements as CampaignPlacement[], prerequisites };
  }
  throw new Error(`内容里没有可交互的 ${kind} 目标（${description}）`);
}
/** 把一条任务的前置接上，再接下它自己——用例要的是「接取后就地交互」。 */
function admit(session: Session, quest: CampaignQuest, prerequisites: CampaignQuest[]): void {
  for (const previous of prerequisites) session.accept(previous.id);
  assert.equal(session.accept(quest.id), true, `任务 ${quest.id} 接不了`);
}

// 原版类型 0 的 `IsComplete` 找到运行池记录就返回真，但状态 1→2 的写入在 `OnEvent`，
// 要等一次 NPC 交互（findings 45、109、232）。所以接取后先停在 active，对话一次才 ready。
test('a talk quest is ready on acceptance and settles with one delivery interaction', async () => {
  const quest=campaign.quests.find(q=>q.id==='quest-103')!;
  const placement=campaign.placements.find(p=>p.characterId===quest.deliveryCharacterId)!;
  const h=harness();
  h.session.applyStoryCommands([{type:'travel',destination:{map:placement.map,x:placement.x,y:placement.y,facing:'south'}}]);
  h.session.accept(quest.id);
  assert.equal(h.session.status(quest.id),'ready');
  assert.deepEqual(h.session.quests.get(quest.id)!.goals,{});
  assert.equal(await h.director.interact(placement,world.actors[placement.actor]),true);
  assert.equal(h.session.status(quest.id),'completed');
  h.director.dispose();
});

test('an interact goal completes on the target NPC even though it is not the quest giver', async () => {
  const { quest, goals, placements, prerequisites } = elsewhereTargetQuest('interact');
  const h = harness();
  assert.equal(h.session.canInteract(goals[0].target, placements[0].id), false, '任务没进行时它不是额外的可交互对象');
  admit(h.session, quest, prerequisites);
  assert.deepEqual(h.session.forActor(goals[0].target), [], '它不是发布者，走的是目标记账，不是交付');
  // 这条任务有几个同类目标就逐个走完：整条任务达成的前提是全部目标都记上。
  for (const [index, goal] of goals.entries()) {
    const placement = placements[index];
    assert.equal(h.session.canInteract(goal.target, placement.id), true, '进行中任务的目标算可交互对象');
    await h.director.interact(placement, world.actors[placement.actor]);
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], goal.quantity);
  }
  assert.equal(h.session.status(quest.id), 'ready');
  for (const [index, goal] of goals.entries()) {
    assert.equal(h.session.canInteract(goal.target, placements[index].id), false, '目标达成后不再是进行中任务的目标');
  }
});

test('talking to an unrelated NPC says a line and records no quest fact', async () => {
  const { quest, goals, prerequisites } = elsewhereTargetQuest('interact');
  const h = harness();
  const goal = goals[0];
  admit(h.session, quest, prerequisites);
  assert.equal(h.session.status(quest.id), 'active');
  assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 0);
  const entity: EntityPlacement = { id: 'bystander', actor: 'bystander', x: 0, y: 0 };
  const actor = { id: 'bystander', name: '路人', description: '路过的人' } as unknown as ActorDefinition;
  assert.equal(h.session.canInteract('bystander', entity.id), false);
  assert.equal(await h.director.interact(entity, actor), true);
  assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 0);
  assert.equal(h.session.status(quest.id), 'active', '不相关的一次交互不推进任务');
  assert.deepEqual(h.session.captureState().factSequences, [], '不相关的一次交互不产生任务事实');
  assert.deepEqual(h.lines, ['路过的人']);
});

test('an interaction advances only the talk and interact goals that point at that NPC', () => {
  const rules: CampaignQuest = {
    id: 'mixed', title: '混合目标', description: '混合目标', giver: 'elder', guidance: { available: '接取', active: '进行中' }, completion: 'all',
    goals: [
      { id: 'talk', kind: 'talk', target: 'elder', quantity: 1 }, { id: 'interact', kind: 'interact', target: 'elder', quantity: 1 },
      { id: 'item', kind: 'item', target: 'elder', quantity: 1 }, { id: 'defeat', kind: 'defeat', target: 'elder', quantity: 1 }
    ], progressText: '进行中', completeText: '完成'
  };
  const session = new Session({ ...campaign, quests: [rules], placements: [], questGroups: [], events: [] } as Campaign);
  session.accept('mixed');
  assert.equal(session.interact('elder', 'elder-instance'), true);
  assert.deepEqual(session.quests.get('mixed')!.goals, { talk: 1, interact: 1, item: 0, defeat: 0 });
  assert.equal(session.status('mixed'), 'active', '同名的物品与击败目标不受交互影响');
  assert.deepEqual(session.captureState().factSequences, [['talk', 1], ['interaction', 1]]);
  assert.equal(session.interact('stranger', 'stranger-instance'), false, '没有指向这个 NPC 的目标时什么都不记');
  assert.deepEqual(session.captureState().factSequences, [['talk', 1], ['interaction', 1]]);
});

// 隐藏任务不进任务日志，但原版仍要在它指定的对象上交付：#50「打开地下矿山之门」由剧情事件接取，
// 钥匙由同一段剧情的事件命令发放，交付对象是矿洞里的路障（NPC 341，景物）。只按日志可见性挑交互对象，
// 会让这类任务永远停在待交付——原版事件只负责接取，没有第二条结算路径。
test('a hidden quest settles on the object it names once its event has granted it', async()=>{
  const quest = campaign.quests.find(quest=>quest.id==='quest-50')!;
  const placement = campaign.placements.find(candidate=>candidate.actor===(quest.delivery??quest.giver) && !candidate.objective)!;
  const h = harness();
  assert.equal(h.session.questBook.visible(quest.id), false, '隐藏任务不进日志');
  // 原版事件 62 在矿洞里把 #50 接上、同时发钥匙；这里直接接取，再补上事件发的那把钥匙。
  h.session.accept(quest.id);
  h.session.bag.add('west-mine-key', 1);
  h.session.applyStoryCommands([{ type: 'quest', command: { type: 'refresh' } }]);
  assert.equal(h.session.status(quest.id), 'ready');
  assert.equal(h.session.itemCount('west-mine-key'), 1, '钥匙来自剧情事件，接取时不再补发');
  assert.equal(await h.director.interact(placement, world.actors[placement.actor]), true);
  assert.equal(h.session.status(quest.id), 'completed');
  assert.equal(h.session.itemCount('west-mine-key'), 0, '交付扣掉钥匙');
});

// 场景层只替 Phaser 的模块边界，挑选逻辑跑生产代码（同 `chest-interaction.test.ts` 的做法）。
const phaser = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
    'export default {Geom:{Rectangle:class{}},BlendModes:{NORMAL:0,ADD:1,SCREEN:2,MULTIPLY:3},Scene:class{},Physics:{Arcade:{Body:class{}}}};')}` }
    : next(specifier, context);
} });
const { WorldScene } = await import('../src/scenes/world-scene.ts');
phaser.deregister();

interface SceneNear { near: { entity: EntityPlacement } | null; updateInteractionTarget(): void }
/** 只搭 `updateInteractionTarget` 用到的字段：操控者、候选人物与能力接口。 */
function sceneNear(session: Session, placement: CampaignPlacement): SceneNear {
  const character = { entity: placement, actor: world.actors[placement.actor], container: { x: placement.x, y: placement.y, visible: true } };
  return Object.setPrototypeOf({ app: { session, campaign }, player: { container: { x: placement.x, y: placement.y + 20 } },
    characters: [character], near: null }, WorldScene.prototype) as unknown as SceneNear;
}
/** 当前选中的可交互对象 id。用函数读，免得 `assert.equal` 的断言签名把字段收窄成 `null`。 */
function nearId(scene: SceneNear): string | null { return scene.near?.entity.id ?? null; }

test('an NPC that is only a quest target joins the interaction candidates while its quest runs', () => {
  const { quest, goals, placements, prerequisites } = elsewhereTargetQuest('interact');
  const session = new Session(campaign), scene = sceneNear(session, placements[0]);
  scene.updateInteractionTarget();
  assert.equal(nearId(scene), null, '没有任务身份时它只是普通摆放点');
  admit(session, quest, prerequisites);
  scene.updateInteractionTarget();
  assert.equal(nearId(scene), placements[0].id, '任务进行中它是身边的可交互对象');
  for (const [index, goal] of goals.entries()) session.interact(goal.target, placements[index].id);
  scene.updateInteractionTarget();
  assert.equal(nearId(scene), null, '目标达成后不再是可交互对象');
});


/** 搭一组同坐标的候选对象：用来验证「进行中任务目标」在平分距离时压过交付人。 */
function sceneNearMany(session: Session, placements: CampaignPlacement[], x: number, y: number): SceneNear {
  const characters = placements.map(placement => ({ entity: placement, actor: world.actors[placement.actor],
    container: { x: placement.x, y: placement.y, visible: true } }));
  return Object.setPrototypeOf({ app: { session, campaign }, player: { container: { x, y } },
    characters, near: null }, WorldScene.prototype) as unknown as SceneNear;
}

test('a ready talk quest makes its delivery NPC the preferred neighbour', () => {
  const placements = campaign.placements.filter(placement => placement.characterId === 'npc-364');
  const plain = { ...placements[0]!, id: 'bystander', characterId: 'npc-999' };
  const session = new Session({ ...campaign }), target = placements[0]!;
  const scene = sceneNearMany(session, [plain, target], target.x, target.y + 20);
  assert.equal(session.canInteract(target.actor, target.id, target.characterId), false, '任务没进行时它只是普通对象');
  assert.equal(session.accept('quest-103'), true);
  assert.equal(session.markerActor(target.actor,target.characterId),true,'待交付任务通过交付菜单交互');
  scene.updateInteractionTarget();
  assert.equal(nearId(scene), target.id, '同距离时优先任务对象');
});

test('native quest 466 settles at its menu NPC rather than the different NPC in its detail table', async () => {
  const quest = campaign.quests.find(quest => quest.id === 'quest-466')!;
  assert.equal(quest.giver, undefined);
  assert.equal(quest.delivery, 'boulder-blocking-the-cave-fc43f63b');
  const h = harness();
  h.session.applyStoryCommands([{type:'quest', command:{type:'accept', quest:quest.id}}]);
  const detailActor = quest.descriptionTargets![0].target;
  assert.notEqual(detailActor, quest.delivery);
  assert.deepEqual(h.session.deliverablesFor(detailActor), []);
  const goalPlacement = campaign.placements.find(candidate => candidate.actor === detailActor)!;
  await h.director.interact(goalPlacement, world.actors[goalPlacement.actor]);
  assert.equal(h.session.status(quest.id), 'ready', '说明对象的对话不改变已就绪的任务状态');
  const placement = campaign.placements.find(candidate => candidate.actor === quest.delivery)!;
  await h.director.interact(placement, world.actors[placement.actor]);
  assert.equal(h.session.status(quest.id), 'completed');
  h.director.dispose();
});
