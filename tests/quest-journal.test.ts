import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCampaign } from '../src/application/content-validation.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { QuestProgress } from '../src/domain/quest-book.ts';
import { questJournal, questJournalText } from '../src/domain/quest-journal.ts';
import { plainQuestText, questTextParts } from '../src/domain/quest-text.ts';
import { Session } from '../src/domain/session.ts';

const campaign = parseCampaign(JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')));
const names: Record<string, string> = { janus: '贝伦多', portia: '费罗赛普妮' };

function questProgress(status:QuestProgress['status'],goals:Record<string,number>={}):QuestProgress{return {status,goals,cycle:0,completedCycles:status==='completed'?1:0};}
function states(entries:Record<string,QuestProgress>):Map<string,QuestProgress>{return new Map(Object.entries(entries));}

test('journal follows the opening native quest group, keeping history only in the current group', () => {
  const session = new Session(campaign);
  assert.deepEqual(questJournal(campaign, session.quests), []);
  session.accept('grafton-mission');
  let groups = questJournal(campaign, session.quests);
  assert.deepEqual(groups.map(group => [group.definition.title, group.ready]), [['刺杀格里普顿伯爵', false]]);
  session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
  assert.equal(questJournal(campaign, session.quests)[0].ready, true);
  session.complete('grafton-mission');
  assert.deepEqual(questJournal(campaign, session.quests), []);
  session.accept('cardinal-summons');
  session.interact('janus','test','npc-55');
  session.complete('cardinal-summons');
  session.accept('meet-portia');
  session.interact('portia','test','npc-54');
  session.complete('meet-portia');
  session.accept('knight-uniform');
  groups = questJournal(campaign, session.quests);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].definition.title, '黑暗教团教主的任务');
  assert.deepEqual(groups[0].entries.map(entry => entry.quest.id), ['knight-uniform', 'meet-portia', 'cardinal-summons']);
  assert.equal(groups[0].ready, false);
});

test('a GM focus keeps only the selected quest in the journal', () => {
  const progress = states({
    'grafton-mission': questProgress('active'),
    'cardinal-summons': questProgress('ready'),
    'meet-portia': questProgress('completed'),
  });
  assert.ok(questJournal(campaign, progress).length > 1, '没有焦点时保留多个任务组');
  const focused = questJournal(campaign, progress, 'meet-portia');
  assert.deepEqual(focused.flatMap(group => group.entries.map(entry => entry.quest.id)), ['meet-portia']);
  assert.equal(focused[0].definition.id, campaign.questGroups.find(group => group.questIds.includes('meet-portia'))!.id);
  assert.deepEqual(questJournal(campaign, progress, 'knight-uniform'), [], '焦点任务未接取时不显示空组');
});

test('a GM focus shows the task even when it is hidden or only available', () => {
  const progress = states({
    'grafton-mission': questProgress('available'),
    'knight-uniform': questProgress('active'),
  });
  // 普通日志只收已接取任务；现场表可能停在开幕演出之前，此时焦点任务还是可接取。
  assert.deepEqual(questJournal(campaign, progress).flatMap(group => group.entries.map(entry => entry.quest.id)),
    ['knight-uniform']);
  assert.deepEqual(questJournal(campaign, progress, 'grafton-mission').flatMap(group => group.entries.map(entry => entry.quest.id)),
    ['grafton-mission']);
  // 隐藏任务的可见性规则同样由焦点覆盖。
  const hidden = structuredClone(campaign);
  hidden.quests.find(quest => quest.id === 'grafton-mission')!.hidden = true;
  assert.deepEqual(questJournal(hidden, progress, 'grafton-mission').flatMap(group => group.entries.map(entry => entry.quest.id)),
    ['grafton-mission']);
  // 未解锁任务没有现场可显示。
  assert.deepEqual(questJournal(campaign, states({ 'grafton-mission': questProgress('locked') }), 'grafton-mission'), []);
});

test('main and side groups follow game progression rather than quest-group id order', () => {
  const groups = questJournal(campaign, states({
    'quest-18': questProgress('active'),
    'quest-222': questProgress('active'),
  }));
  // 两个都是支线；按任务在 campaign.quests 里的先后，quest-18 应排在 quest-222 前面。
  assert.deepEqual(groups.map(group => group.definition.id), ['native-group-12', 'native-group-103']);
});

test('a talk quest describes its target without inventing a progress counter', () => {
  const quest = campaign.quests.find(entry => entry.id === 'quest-103')!;
  const text = questJournalText({ definition: campaign.questGroups[0], ready: false,
    entries: [{ quest, state: questProgress('active', { objective: 0 }) }] }, id => names[id] ?? id);
  assert.match(text, /与黑魔法师 卡茵进行对话/);
  assert.doesNotMatch(text, /0\/1/);
});

test('groups appear once, main quests precede side quests, and unreached steps stay hidden', () => {
  const content: Campaign = structuredClone(campaign);
  content.questGroups.find(group=>group.questIds.includes('grafton-mission'))!.kind = 'side';
  const groups = questJournal(content, states({
    'grafton-mission': questProgress('active'),
    'cardinal-summons': questProgress('completed'),
    'meet-portia': questProgress('ready'),
    'knight-uniform': questProgress('available'),
  }));
  assert.deepEqual(groups.map(group => group.definition.id), ['native-group-4', 'native-group-2']);
  assert.deepEqual(groups[0].entries.map(entry => entry.quest.id), ['meet-portia', 'cardinal-summons']);
  assert.equal(groups[0].ready, true);
  assert.equal(groups[1].ready, false);
  assert.deepEqual(questJournal(content, states(Object.fromEntries(content.quests.map(quest => [quest.id, questProgress('completed')])))), []);
});

test('journal shows live objective progress and uniformly gray completed descriptions', () => {
  const progress = states({
    'cardinal-summons': questProgress('completed'),
    'meet-portia': questProgress('completed'),
    'knight-uniform': questProgress('active',{objective:2}),
  });
  let group = questJournal(campaign, progress)[0];
  let text = questJournalText(group, id => names[id]);
  assert.ok(text.includes('$R&N灵魂物质: 2/5$B'));
  const parts = questTextParts(text), completedStart = parts.findIndex(part => 'text' in part && part.text === '[完成]');
  assert.ok(completedStart > 0);
  assert.ok(parts.slice(completedStart).filter(part => 'text' in part && part.text.trim()).every(part => 'text' in part && part.tone === 'muted'));
  assert.equal(plainQuestText(text).includes('$'), false);
  assert.equal(plainQuestText(text).includes('&C'), false);
  progress.set('knight-uniform', questProgress('ready',{objective:9}));
  group = questJournal(campaign, progress)[0];
  text = questJournalText(group, id => names[id]);
  assert.ok(text.includes('$S&N灵魂物质: 5/5$B'));
  assert.equal(group.ready, true);
  const talk = questJournal(campaign, states({ 'cardinal-summons': questProgress('ready') }))[0];
  assert.ok(questJournalText(talk, id => names[id]).includes('$S&N与贝伦多进行对话$B'));
});

test('campaign validation rejects missing, duplicate, or unknown journal group references', () => {
  const invalid = (change: (content: Campaign) => void, message: RegExp) => {
    const content = structuredClone(campaign); change(content);
    assert.throws(() => parseCampaign(content), message);
  };
  invalid(content => { content.questGroups = []; }, /所属分组/);
  invalid(content => { content.questGroups[0].questIds.push('grafton-mission'); }, /标识重复/);
  invalid(content => { content.questGroups[0].questIds.push('unknown'); }, /任务不存在/);
  invalid(content => { content.questGroups[0].questIds = []; }, /至少一个任务/);
  invalid(content => { content.quests[0].goals[0].target=''; }, /目标标识/);
});

test('multiple goals display independent counts and colors, without inferring completion from an aggregate',()=>{
  const content=structuredClone(campaign),quest=content.quests[0];
  quest.goals=[{id:'meat',kind:'item',target:'meat',quantity:5,label:'蛆虫肉'},{id:'bone',kind:'item',target:'bone',quantity:5,label:'蝙蝠脆骨'}];
  const group=questJournal(content,states({[quest.id]:questProgress('active',{meat:5,bone:2})}))[0];
  const text=questJournalText(group,id=>id);
  assert.ok(text.includes('$S&N蛆虫肉: 5/5$B$R&N蝙蝠脆骨: 2/5$B'));
  assert.equal(group.ready,false);assert.ok(plainQuestText(text).includes('蛆虫肉: 5/5\n蝙蝠脆骨: 2/5'));
});

test('hidden and internal tasks keep their progress outside the player journal',()=>{
  const content=structuredClone(campaign);
  content.quests[0].hidden=true;content.quests[1].completion='internal';
  const groups=questJournal(content,states({[content.quests[0].id]:questProgress('active'),[content.quests[1].id]:questProgress('ready'),[content.quests[2].id]:questProgress('active')}));
  assert.deepEqual(groups.flatMap(group=>group.entries.map(entry=>entry.quest.id)),[content.quests[2].id]);
});
