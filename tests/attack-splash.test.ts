import assert from 'node:assert/strict';
import test from 'node:test';
import type {Combatant} from '../src/domain/combat.ts';
import {attackSplashTargets,selectAttackSplashCenter} from '../src/domain/attack-splash.ts';

const actor=(id:string,x:number,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},
  facing:'east',bounds:{x:-8,y:-8,width:16,height:16}});
const source=actor('caster',0,0,'party');

test('fire current target uses body reach and falls back to caster without searching a replacement',()=>{
  const current=actor('current',31),near=actor('near',8);
  assert.equal(selectAttackSplashCenter(source,[current,near],3,{currentTargetId:'current'}).targetId,'current');
  current.position.x=32;
  assert.deepEqual(selectAttackSplashCenter(source,[current,near],3,{currentTargetId:'current'}),
    {center:source.position});
  assert.deepEqual(attackSplashTargets(source,source.position,[current],3),[]);
});

test('missing target search uses a 24 pixel score radius, stable ties and visibility',()=>{
  const first=actor('first',16),tie=actor('tie',16),hidden=actor('hidden',8);hidden.states=['stealthed'];
  assert.equal(selectAttackSplashCenter(source,[hidden,first,tie],3).targetId,'first');
  assert.equal(selectAttackSplashCenter(source,[actor('outside',25)],3).targetId,undefined);
  assert.equal(selectAttackSplashCenter(source,[actor('edge',24)],3).targetId,'edge');
  assert.equal(selectAttackSplashCenter(source,[actor('zero-score',-24)],3).targetId,undefined);
});

test('fire splash uses quantized octagonal feet, includes the primary and keeps immune slots',()=>{
  const axis=actor('axis',31),diagonal=actor('diagonal',22,22),outside=actor('outside',32),diagonalOutside=actor('diagonal-outside',23,23);
  const immune=actor('immune',8);immune.states=['damage-immune'];
  const hidden=actor('hidden',0);hidden.states=['stealthed'];
  assert.deepEqual(attackSplashTargets(source,source.position,[axis,diagonal,outside,diagonalOutside,immune,hidden,source],3).map(x=>x.id),
    ['axis','diagonal','immune']);
  const targets=Array.from({length:17},(_,i)=>actor(`enemy-${i}`,i));targets[0].states=['damage-immune'];
  assert.deepEqual(attackSplashTargets(source,source.position,targets,3).map(x=>x.id),targets.slice(0,16).map(x=>x.id));
  const prefix=Array.from({length:100},(_,i)=>actor(`friend-${i}`,0,0,'party'));
  assert.equal(attackSplashTargets(source,source.position,[...prefix,axis],3).length,0);
});
