import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseBattle } from '../src/application/content-validation.ts';
import {resolveStateApplication,selectStateDurationProfile,type StateApplicationRequest,type StateApplicationRules} from '../src/domain/state-application.ts';
import type {StateDurationProfile} from '../src/domain/battle.ts';

const action:StateApplicationRequest={kind:'action',state:'stun',sourceRelation:'hostile',chanceThreshold:1000};
const noRoll=()=>assert.fail('this state branch does not consume a random number');
const allowed={allowed:true,durationScale:1,buffDurationScale:1,frameDurationScale:1};

test('shield-bash stores state chance and duration in its first two formulas',()=>{
  const catalog=parseBattle(JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')));
  const stun=catalog.skills['shield-bash'].action!.combatUnits!.find(unit=>unit.effect==='state')!;
  assert.deepEqual(stun.ranks[0],{chanceThreshold:1000,durationMs:1200,
    stateDurationProfile:{normal:{lastActiveFrame:19},targetShortened:{lastActiveFrame:9}}});
});

test('action probability runs before immunity, uses a strict threshold and only 1000 skips its roll',()=>{
  assert.deepEqual(resolveStateApplication(action,noRoll),allowed);
  let rolls=0;
  const random=()=>{rolls++;return 0;};
  assert.deepEqual(resolveStateApplication({...action,chanceThreshold:0,specificImmunityValue:1},random),
    {allowed:false,reason:'chance'});
  assert.equal(rolls,1);
  assert.deepEqual(resolveStateApplication({...action,chanceThreshold:500},()=>498/999),allowed);
  assert.deepEqual(resolveStateApplication({...action,chanceThreshold:500},()=>499/999),{allowed:false,reason:'chance'});
  assert.deepEqual(resolveStateApplication({...action,chanceThreshold:1001},random),allowed);
  assert.equal(rolls,2);
  assert.deepEqual(resolveStateApplication({...action,sourceRelation:'none'},noRoll),{allowed:false,reason:'missing-source'});
});

test('positive specific immunity rejects immediately instead of being treated as a chance',()=>{
  for(const state of ['blind','sleep','stun','fear','silence','slowed']){
    assert.deepEqual(resolveStateApplication({...action,state,specificImmunityValue:1,resistanceThreshold:1000},noRoll),
      {allowed:false,reason:'immune'});
    assert.deepEqual(resolveStateApplication({...action,state,specificImmunityValue:0},noRoll),allowed);
    assert.deepEqual(resolveStateApplication({...action,state,specificImmunityValue:-1},noRoll),allowed);
  }
});

test('compiled actor rules reject listed states or all states and shorten the remaining direct states',()=>{
  const rules={immuneStates:['immobilized','sleep','stun'],durationScale:0.5 as const};
  for(const state of ['immobilized','sleep','stun'])
    assert.deepEqual(resolveStateApplication({...action,state,rules,resistanceThreshold:999},noRoll),{allowed:false,reason:'immune'});
  assert.deepEqual(resolveStateApplication({...action,state:'ambush',rules},noRoll),{...allowed,durationScale:0.5});
  assert.deepEqual(resolveStateApplication({...action,state:'stealthed',rules:{immuneToAllStates:true}},noRoll),
    {allowed:false,reason:'immune'});
});

test('generic resistance rolls only for hostile sources after immunity and never gets the guaranteed-chance shortcut',()=>{
  for(const resistanceThreshold of [0,-1])assert.deepEqual(resolveStateApplication({...action,resistanceThreshold},noRoll),allowed);
  assert.deepEqual(resolveStateApplication({...action,sourceRelation:'friendly',resistanceThreshold:1000},noRoll),allowed);
  assert.deepEqual(resolveStateApplication({...action,resistanceThreshold:500},()=>498/999),{allowed:false,reason:'resisted'});
  assert.deepEqual(resolveStateApplication({...action,resistanceThreshold:500},()=>499/999),allowed);
  let rolls=0;
  assert.deepEqual(resolveStateApplication({...action,resistanceThreshold:1000},()=>{rolls++;return 998/999;}),
    {allowed:false,reason:'resisted'});
  assert.equal(rolls,1);
});

test('buff states skip action chance but keep individual immunity, hostile resistance and distinct duration stages',()=>{
  const buff={kind:'buff',state:'sleep',sourceRelation:'hostile'} as const;
  assert.deepEqual(resolveStateApplication(buff,noRoll),allowed);
  assert.deepEqual(resolveStateApplication({...buff,specificImmunityValue:1},noRoll),{allowed:false,reason:'immune'});
  assert.deepEqual(resolveStateApplication({...buff,resistanceThreshold:2},()=>0),{allowed:false,reason:'resisted'});
  assert.deepEqual(resolveStateApplication({...buff,sourceRelation:'none',resistanceThreshold:1000},noRoll),allowed);
  const rules:StateApplicationRules={durationScale:0.5,buffDurationScaleByState:{sleep:0.5},frameDurationScale:0.5};
  assert.deepEqual(resolveStateApplication({...buff,rules},noRoll),
    {allowed:true,durationScale:0.5,buffDurationScale:0.5,frameDurationScale:0.5});
  assert.deepEqual(resolveStateApplication({...action,state:'sleep',rules},noRoll),
    {allowed:true,durationScale:0.5,buffDurationScale:1,frameDurationScale:0.5});
  assert.deepEqual(resolveStateApplication({...buff,state:'stun',rules},noRoll),
    {allowed:true,durationScale:0.5,buffDurationScale:1,frameDurationScale:0.5});
});

test('duration profiles select precomputed rounded ages before optional final frame shortening',()=>{
  const profile:StateDurationProfile={normal:{lastActiveFrame:22},targetShortened:{lastActiveFrame:10},
    buffShortened:{lastActiveFrame:10},buffAndTargetShortened:{lastActiveFrame:4}};
  for(const [durationScale,buffDurationScale,expected] of [[1,1,22],[0.5,1,10],[1,0.5,10],[0.5,0.5,4]] as const){
    const decision={allowed:true as const,durationScale,buffDurationScale,frameDurationScale:1 as const};
    assert.deepEqual(selectStateDurationProfile(profile,decision),{lastActiveFrame:expected});
    assert.deepEqual(selectStateDurationProfile(profile,{...decision,frameDurationScale:0.5}),{lastActiveFrame:expected/2});
  }
  const decision=resolveStateApplication({...action,rules:{durationScale:0.5}},noRoll);
  assert.ok(decision.allowed);
  assert.throws(()=>selectStateDurationProfile({normal:{lastActiveFrame:22}},decision),/targetShortened/);
  const timing=selectStateDurationProfile(profile,{allowed:true,durationScale:1,buffDurationScale:1,frameDurationScale:1});
  timing.lastActiveFrame=999;assert.equal(profile.normal.lastActiveFrame,22);
  assert.equal(selectStateDurationProfile({normal:{lastActiveFrame:45}},
    {allowed:true,durationScale:1,buffDurationScale:1,frameDurationScale:0.5}).lastActiveFrame,22);
});
