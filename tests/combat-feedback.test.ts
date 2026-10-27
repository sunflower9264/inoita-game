import test from 'node:test';
import assert from 'node:assert/strict';
import { damageDigits, digitSequence, feedbackPlan, reusableDigit, selectFeedbackAssets, type CombatHitFeedback, type CombatFeedbackDefinition } from '../src/domain/combat-feedback.ts';
import { statusColorMatrix } from '../src/domain/status-color.ts';
import fs from 'node:fs';
import { parseBattle } from '../src/application/content-validation.ts';

const event:CombatHitFeedback={hit:{kind:'hit',damage:35},style:'weapon',periodic:false,
  casterControlled:true,targetFriendly:false,targetParty:false,involvesControlled:true};
const definition:CombatFeedbackDefinition={
  digits:{enemy:['enemy-0','enemy-1','enemy-2'],enemyCritical:['enemy-critical'],party:['party'],partyCritical:['party-critical'],miss:['miss-digits']},
  normalImpacts:['normal-0','normal-1','normal-2','normal-3','normal-4'],skillImpact:'skill',criticalImpact:'critical',
  criticalRing:'ring',criticalBursts:['burst-0','burst-1','burst-2','burst-3'],missEffect:'miss',shakeOffsets:[],
};

test('feedback selects the normal impact before enemy digits using the supplied combat random stream',()=>{
  const values=[.99,.4];
  assert.deepEqual(selectFeedbackAssets(event,definition,()=>values.shift()!),{
    impacts:[{name:'normal-4',attached:true}],digitEffect:'enemy-1'});
  assert.deepEqual(values,[]);
});

test('all native feedback branches consume only their variable asset choices',()=>{
  const cases:{change:Partial<CombatHitFeedback>;draws:number;impact?:string;digit?:string}[]=[
    {change:{},draws:2,impact:'normal-0',digit:'enemy-0'},
    {change:{style:'skill'},draws:1,impact:'skill',digit:'enemy-0'},
    {change:{hit:{kind:'critical',damage:70}},draws:1,impact:'critical',digit:'enemy-critical'},
    {change:{style:'skill',hit:{kind:'critical',damage:70}},draws:1,impact:'skill',digit:'enemy-critical'},
    {change:{hit:{kind:'weapon-block',damage:10}},draws:1,digit:'enemy-0'},
    {change:{hit:{kind:'shield-block',damage:10}},draws:1,digit:'enemy-0'},
    {change:{periodic:true},draws:1,digit:'enemy-0'},
    {change:{targetFriendly:true,targetParty:true},draws:1,impact:'normal-0',digit:'party'},
    {change:{hit:{kind:'miss',damage:0}},draws:0,impact:'miss',digit:'miss-digits'},
    {change:{hit:{kind:'hit',damage:0}},draws:0},
    {change:{involvesControlled:false},draws:1,impact:'normal-0'},
    {change:{involvesControlled:false,hit:{kind:'critical',damage:70}},draws:0},
    {change:{involvesControlled:false,targetParty:true,targetFriendly:true,hit:{kind:'critical',damage:70}},draws:0,digit:'party-critical'},
    {change:{involvesControlled:false,hit:{kind:'miss',damage:0}},draws:0},
  ];
  for(const value of cases){
    let draws=0;
    const selected=selectFeedbackAssets({...event,...value.change},definition,()=>{draws++;return 0;});
    assert.equal(draws,value.draws,JSON.stringify(value.change));
    assert.equal(selected.impacts[0]?.name,value.impact);
    assert.equal(selected.digitEffect,value.digit);
  }
});

test('critical burst selection preserves all layers and detaches only the burst',()=>{
  assert.deepEqual(selectFeedbackAssets({...event,hit:{kind:'critical',damage:70}},definition,()=>.99),{
    impacts:[{name:'critical',attached:true},{name:'ring',attached:true},{name:'burst-3',attached:false}],digitEffect:'enemy-critical'});
});

test('critical decorations can be omitted without changing the random stream',()=>{
  const critical={...event,hit:{kind:'critical' as const,damage:70}};
  const pool={...definition,digits:{...definition.digits,enemyCritical:['crit-0','crit-1','crit-2','crit-3']}};
  const run=(decorations:boolean)=>{
    const values=[.99,.5];let draws=0;
    const selected=selectFeedbackAssets(critical,pool,()=>values[draws++]!,decorations);
    return {selected,draws};
  };
  const on=run(true),off=run(false);
  assert.deepEqual(on.selected.impacts,[
    {name:'critical',attached:true},{name:'ring',attached:true},{name:'burst-3',attached:false}]);
  assert.equal(on.selected.digitEffect,'crit-2');
  assert.deepEqual(off.selected.impacts,[{name:'critical',attached:true}]);
  assert.equal(off.selected.digitEffect,'crit-2','关闭装饰仍消费爆闪随机数，数字选择不漂移');
  assert.equal(on.draws,2);assert.equal(off.draws,2);
  const skill=selectFeedbackAssets({...critical,style:'skill'},pool,()=>.99,false);
  assert.deepEqual(skill.impacts,[{name:'skill',attached:true}]);
});

test('native miss, block, periodic and critical feedback stay distinct',()=>{
  assert.deepEqual(feedbackPlan({...event,hit:{kind:'miss',damage:0}}),{digits:true,digitStyle:'miss',impact:'miss',flash:false,shake:false});
  assert.deepEqual(feedbackPlan({...event,hit:{kind:'critical',damage:70}}),{digits:true,digitStyle:'enemyCritical',impact:'critical',flash:true,shake:true});
  for(const kind of ['shield-block','weapon-block'] as const)
    assert.equal(feedbackPlan({...event,hit:{kind,damage:10}}).impact,null);
  assert.equal(feedbackPlan({...event,periodic:true}).impact,null);
  assert.deepEqual(feedbackPlan({...event,hit:{kind:'hit',damage:0}}),{digits:false,digitStyle:'enemy',impact:null,flash:false,shake:false});
});

test('party and summon visibility does not grant companions the controlled player shake',()=>{
  const critical={...event,hit:{kind:'critical' as const,damage:70},casterControlled:false};
  assert.equal(feedbackPlan(critical).shake,false);
  assert.equal(feedbackPlan(critical).impact,'critical');
  assert.equal(feedbackPlan({...critical,involvesControlled:false}).digits,false);
  const party=feedbackPlan({...critical,involvesControlled:false,targetParty:true,targetFriendly:true});
  assert.equal(party.digits,true);assert.equal(party.digitStyle,'partyCritical');assert.equal(party.impact,null);
});

test('native digits stagger, alternate height and hold at source frame four',()=>{
  assert.deepEqual(damageDigits(123),[
    {digit:1,x:-12,y:0,delayMs:0,holdFrames:2},
    {digit:2,x:-4,y:2,delayMs:60,holdFrames:1},
    {digit:3,x:4,y:0,delayMs:120,holdFrames:0}]);
  assert.deepEqual(digitSequence(7,2),[0,1,2,3,4,4,4,5,6]);
  assert.deepEqual(damageDigits(0,true),[{digit:10,x:0,y:0,delayMs:0,holdFrames:0}]);
  assert.equal(reusableDigit([-2,0,4,4,3]),2);
  assert.equal(reusableDigit([-2,0,0]),-1);
});

test('hit gamma brightens dark pixels while keeping buff colors and alpha',()=>{
  const flash=statusColorMatrix([{red:0,green:0,blue:0}],0,true);
  assert.equal(flash[0]*40+flash[4],148);
  assert.equal(flash[18],1);assert.equal(flash[19],0);
  const color={red:50,green:100,blue:150};
  const composed=statusColorMatrix([color],0,true);
  assert.equal(composed[0]*40+composed[4],148*(1-50/255)+50);
  assert.deepEqual(statusColorMatrix([color],0),statusColorMatrix([color],0,false));
});

test('add and screen layers keep their black unit background black while still flashing',()=>{
  const normal=statusColorMatrix([{red:0,green:0,blue:0}],0,true);
  const blackUnit=statusColorMatrix([{red:0,green:0,blue:0}],0,true,true);
  assert.equal(normal[4],128,'普通层闪白沿用原版 gamma 偏移');
  for(const offset of [4,9,14])assert.equal(blackUnit[offset],0);
  for(const scale of [0,6,12])assert.equal(blackUnit[scale]*0+blackUnit[scale+4],0,'黑底图层必须保持黑');
  assert.ok(blackUnit[0]>1,'黑底图层的角色像素仍然被提亮');
});

test('content validation requires every native digit and default impact variant',()=>{
  const read=()=>JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
  const digits=read();delete digits.attackEffects[digits.feedback.digits.enemy[0]].clips['7'];
  assert.throws(()=>parseBattle(digits),/特效变体缺失/);
  const impact=read();delete impact.attackEffects[impact.feedback.criticalImpact].clips.default;
  assert.throws(()=>parseBattle(impact),/特效变体缺失/);
});
