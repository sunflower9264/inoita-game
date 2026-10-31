import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancementOddsView, percentText } from '../src/ui/enhancement-odds-lines.ts';
import type { EnhancementOdds } from '../src/domain/enhancement.ts';

const normal=(double:number):EnhancementOdds=>({success:1,double,failure:0,losesLevel:false});
const chaos=(success:number,double:number):EnhancementOdds=>({success,double,failure:1-success,losesLevel:true});

test('普通卷轴用一句话说明当前等级和两个结果',()=>{
  const view=enhancementOddsView(normal(0.25),5,3);
  assert.equal(view.sentence,'当前 +5：75% 到 +6，25% 到 +7');
  assert.equal(view.current,undefined);
  assert.deepEqual(view.rows,[]);
  assert.equal(view.cost,'消耗 1 点耐久（3 → 2）');
  assert.equal(view.costY,238);
});

test('普通卷轴省略概率为零的额外升级',()=>{
  assert.equal(enhancementOddsView(normal(0),5,1).sentence,'当前 +5：100% 到 +6');
  assert.equal(enhancementOddsView(normal(1),5,1).sentence,'当前 +5：100% 到 +7');
});

test('混沌卷轴按降级、升一级、升两级列出结果',()=>{
  const view=enhancementOddsView(chaos(453/998,(453/998)*(92/998)),10,0);
  assert.equal(view.current,'当前 +10');
  assert.equal(view.sentence,undefined);
  assert.deepEqual(view.rows,[
    {result:'→ +9',chance:'55%',tone:'loss'},
    {result:'→ +11',chance:'41%',tone:'single'},
    {result:'→ +12',chance:'4%',tone:'double'}
  ]);
  assert.equal(view.cost,'不消耗耐久');
  assert.equal(view.costY,310);
});

test('混沌卷轴不列出概率为零的结果',()=>{
  const view=enhancementOddsView(chaos(1,0.21),1,0);
  assert.deepEqual(view.rows,[
    {result:'→ +2',chance:'79%',tone:'single'},
    {result:'→ +3',chance:'21%',tone:'double'}
  ]);
  assert.equal(view.costY,286);
});

test('概率取整时用整百分比，低于 0.5% 时保留一位小数',()=>{
  assert.equal(percentText(0.04184),'4%');
  assert.equal(percentText(0.00145),'0.1%');
  assert.equal(percentText(1),'100%');
  assert.equal(percentText(0),'0%');
  assert.equal(percentText(Number.NaN),'0%');
});
