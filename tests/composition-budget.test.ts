import assert from 'node:assert/strict';
import test from 'node:test';
import { CompositionBudget } from '../src/rendering/composition-budget.ts';

test('composition counts work time and excludes waiting for the next frame', async () => {
  let time=100;
  const budget=new CompositionBudget(()=>time);
  assert.equal(budget.due,false);
  time+=4; assert.equal(budget.due,true);
  const resumed=budget.pause(new AbortController().signal);
  time+=100;
  await resumed;
  assert.equal(budget.due,false);
  assert.equal(budget.longestMs,4);
  time+=3;assert.equal(budget.due,false);
  time++;assert.equal(budget.due,true);
});

test('cancelled composition never resumes work', async () => {
  const budget=new CompositionBudget(),controller=new AbortController();
  const pending=budget.pause(controller.signal);
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
