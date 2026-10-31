import { compileScript } from './support/story-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { validateStoryPerformance } from '../src/application/story-performance-validation.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { Session } from '../src/domain/session.ts';
import type { ChoiceOption } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { PerformanceAction } from '../src/domain/story-performance.ts';

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), world = parseWorld(read('world'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(content: Campaign = campaign) {
  const session = new Session(content), actions: PerformanceAction[] = [], lines: string[] = [], locks: boolean[] = [], popups: string[] = [];
  let choose: ((option: ChoiceOption) => void) | undefined, fail = false;
  const ui: StoryUI = {
    async dialogue(line) { lines.push(line.text); },
    choice: () => new Promise(resolve => { choose = resolve; }),
    async questPopup(kind, quest) { popups.push(`${kind}:${quest.id}`); },
    closeDialogue() {}, skipDialogue() {}, toast() {}
  };
  const director = new StoryDirector(content, session, ui, lock => locks.push(lock), {
    begin() {}, async execute(action) { if (fail) throw new Error('load failed'); actions.push(action); }, async finish() {}
  });
  return { session, director, actions, lines, locks, popups, choose: (value: string) => choose!({label: value, value}), fail: (value: boolean) => { fail = value; } };
}

test('the native forest entrance grants the main quest after Darius departs', async () => {
  const h=harness();
  assert.equal(await h.director.enterRegion('event-1','shadow-camp'),true);
  assert.equal(h.director.runtime.eventStatus('event-1'),'completed');
  assert.ok(h.lines.includes('卓拉德大人，你找我？'));
  assert.equal(h.session.status('grafton-mission'),'active');
  await tick();assert.deepEqual(h.locks,[true,false]);
  assert.equal(await h.director.enterRegion('event-1','shadow-camp'),false);
  assert.equal(h.actions.filter(action=>action.type==='leave'&&action.target==='darius').length,1);
  assert.equal(h.actions[0].type,'stage');
  assert.ok(h.actions.some(action=>action.type==='stage'&&action.map==='shadow-forest-west'));
});

test('the native church entrance plays once without completing the conversation task', async () => {
  const h=harness();h.session.accept('cardinal-summons');
  assert.equal(await h.director.enterRegion('event-7','berkel-capital'),true);
  assert.equal(h.director.runtime.eventStatus('event-7'),'completed');
  assert.ok(h.lines.at(-1)?.includes('应该可以去找教主了'));
  assert.equal(h.session.status('cardinal-summons'),'ready','接取时已待交付，入口演出不结算任务');
  assert.deepEqual(h.popups,[]);
  assert.equal(await h.director.enterRegion('event-7','berkel-capital'),false);
});

test('failed or cancelled entrance remains retryable', async () => {
  const h=harness();h.fail(true);
  await assert.rejects(h.director.enterRegion('event-1','shadow-camp'),/load failed/);
  assert.notEqual(h.director.runtime.eventStatus('event-1'),'completed');assert.equal(h.director.busy,false);
  h.fail(false);await h.director.retry();
  assert.equal(h.director.runtime.eventStatus('event-1'),'completed');
  const content=structuredClone(campaign);
  content.scripts['blocked-entry']=compileScript('blocked-entry',[{type:'dialogue',actor:null,speaker:'',text:'等待'}]);
  content.events.find(event=>event.id==='event-1')!.script='blocked-entry';
  const session=new Session(content),ui:StoryUI={
    dialogue:(_line,signal)=>new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true})),
    async choice(){throw new Error('unused');},async questPopup(){},closeDialogue(){},skipDialogue(){},toast(){}};
  const director=new StoryDirector(content,session,ui,()=>{},{begin(){},async execute(){},async finish(){}});
  const cancelled=director.enterRegion('event-1','shadow-camp');await tick();director.cancel();await cancelled;
  assert.notEqual(director.runtime.eventStatus('event-1'),'completed');
});

function popupContent():Campaign {
  const content=structuredClone(campaign),script='popup-entry';
  content.events=[{id:script,source:'region',key:script,map:'shadow-camp',script,region:{x:0,y:0,width:16,height:16}}];
  content.scripts[script]={entry:'accept',nodes:[
    {id:'accept',presentation:[],commands:[{type:'quest',command:{type:'accept',quest:'grafton-mission'}}],exit:{type:'next',target:{script,node:'popup'}}},
    {id:'popup',presentation:[{type:'quest-popup',kind:'start',quest:'grafton-mission'}],commands:[],exit:{type:'end'}}]};
  return content;
}

test('cancelling a task popup retains acceptance and retry confirms it without granting twice', async () => {
  const content=popupContent(),session=new Session(content);
  let pendingPopup=false,confirm=false;
  const ui:StoryUI={async dialogue(){},async choice(){throw new Error('unused');},
    questPopup:(_kind,_quest,_reward,signal)=>{
      pendingPopup=true;if(confirm)return Promise.resolve();
      return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
    },closeDialogue(){},skipDialogue(){},toast(){}};
  const director=new StoryDirector(content,session,ui,()=>{},{begin(){},async execute(){},async finish(){}});
  const entrance=director.enterRegion('popup-entry','shadow-camp');
  for(let i=0;i<20&&!pendingPopup;i++)await tick();
  assert.equal(pendingPopup,true);assert.equal(director.canSkip,false);assert.equal(session.status('grafton-mission'),'active');
  const before=session.captureState().questBook;
  director.cancel();await entrance;
  assert.notEqual(director.runtime.eventStatus('popup-entry'),'completed');
  assert.equal(session.status('grafton-mission'),'active');
  confirm=true;assert.equal(await director.retry(),true);
  assert.equal(director.runtime.eventStatus('popup-entry'),'completed');
  assert.deepEqual(session.captureState().questBook,before);
});

test('entry commands and trigger references are validated', () => {
  const broken=structuredClone(campaign);
  const grant=broken.scripts['event-1'].nodes.flatMap(node=>node.commands).find(command=>command.type==='quest'&&command.command.type==='accept');
  assert.ok(grant?.type==='quest'&&grant.command.type==='accept');
  if(grant?.type==='quest'&&grant.command.type==='accept')grant.command.quest='missing';
  assert.throws(()=>parseCampaign(broken),/任务/);
  const missingScript=structuredClone(campaign);missingScript.events.find(event=>event.id==='event-1')!.script='missing';
  assert.throws(()=>parseCampaign(missingScript),/剧情/);
  const missingMap=structuredClone(campaign);missingMap.events.find(event=>event.id==='event-1')!.map='missing';
  assert.throws(()=>validateStoryPerformance(world,missingMap),/地图缺失/);
});
test('an optional side quest can be postponed and later accepted',async()=>{
  const side=structuredClone(campaign.quests[0]);
  side.giver='darius';side.giverCharacterId='npc-40';side.delivery='darius';side.deliveryCharacterId='npc-40';side.id='side-quest';side.acceptance='optional';side.availableWhen={type:'always',value:true};
  side.offerScript='side-offer';side.completeScript=null;side.rewards=undefined;
  const content:Campaign={...campaign,start:{...campaign.start,script:'side-offer'},quests:[side],questGroups:[],events:[],scripts:{
    'side-offer':{entry:'offer',nodes:[
      {id:'offer',presentation:[{type:'choice',prompt:'支线任务',options:[{label:'接受任务',value:'accept'},{label:'稍后再来',value:'later'}]}],commands:[],exit:{type:'choice',choice:'side-offer',cases:{accept:{script:'side-offer',node:'accept'},later:{script:'side-offer',node:'later'}}}},
      {id:'accept',presentation:[],commands:[{type:'quest',command:{type:'accept',quest:side.id}}],exit:{type:'next',target:{script:'side-offer',node:'popup'}}},
      {id:'popup',presentation:[{type:'quest-popup',kind:'start',quest:side.id}],commands:[],exit:{type:'end'}},
      {id:'later',presentation:[],commands:[],exit:{type:'defer'}}
    ]}
  }};
  const h=harness(content);
  const giver={id:'side-giver',actor:'darius',characterId:'npc-40',x:0,y:0};
  const later=h.director.interact(giver,world.actors.darius);await tick();h.choose('later');await later;
  assert.equal(h.session.status('side-quest'),'available');
  const accepted=h.director.interact(giver,world.actors.darius);await tick();h.choose('accept');await accepted;
  assert.equal(h.session.status('side-quest'),'active');
  assert.deepEqual(h.popups,['start:side-quest']);
});
