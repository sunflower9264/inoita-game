import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bag } from '../src/domain/bag.ts';
import { USE_INTERFACE_ONLY } from '../src/domain/items.ts';
import { ShortcutBar } from '../src/domain/shortcut-bar.ts';
import { RecoveryItems } from '../src/domain/recovery-items.ts';
import { Session } from '../src/domain/session.ts';
import { parseCampaign, parseItemCatalog } from '../src/application/content-validation.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseItemCatalog(read('items'));
// 四档治疗药水按点数回复；元气恢复药水是比例回复，两者形状不同，这里分开取。
const potions=Object.entries(catalog.items).filter(([,item])=>
  item.use?.kind==='recover-health'&&item.use.recovery?.mode==='amount');
const amountRecovery=(index:number)=>{
  const recovery=potions[index]![1].use!.recovery!;
  if(recovery.mode!=='amount')throw new Error('治疗药水应当是点数回复');
  return recovery;
};
const setup=()=>{
  const bag=new Bag(()=>{},catalog,'dark-knight');
  for(const [id] of potions)bag.add(id,3);
  return {bag,recovery:new RecoveryItems(),entry:(index=0)=>bag.entries.find(item=>item.item===potions[index][0])!.id};
};
const member=(id:string,health:number,maxHealth=20000,mana=0,maxMana=20000)=>({id,player:{health,maxHealth,mana,maxMana},
  setHealth(value:number){this.player.health=value;},setMana(value:number){this.player.mana=value;}});

test('four native recovery ranges use inclusive endpoints and a single party roll',()=>{
  assert.deepEqual(potions.map(([,item])=>item.use!.recovery),[
    {mode:'amount',minHealth:2400,maxHealth:3200,restoresMana:false,cooldownMs:9900},
    {mode:'amount',minHealth:4200,maxHealth:5600,restoresMana:false,cooldownMs:9900},
    {mode:'amount',minHealth:7200,maxHealth:9600,restoresMana:false,cooldownMs:9900},
    {mode:'amount',minHealth:12600,maxHealth:16800,restoresMana:false,cooldownMs:9900}]);
  for(let index=0;index<4;index++)for(const random of [0,1-Number.EPSILON]){
    const {bag,recovery,entry}=setup(),party=[member('player',1),member('ally',200)];let rolls=0;
    const result=recovery.use(bag,entry(index),party,'player',{},()=>{rolls++;return random;});
    assert.ok(result.used);assert.equal(rolls,1);
    assert.equal(result.amount,random===0?amountRecovery(index).minHealth:amountRecovery(index).maxHealth);
    assert.equal(party[0].player.health,1+result.amount);assert.equal(party[1].player.health,200+result.amount);
    assert.equal(bag.count(potions[index][0]),2);
  }
});
test('clamps health, skips dead members and preserves native ordered effect recipients',()=>{
  const {bag,recovery,entry}=setup();
  const party=[member('player',20000),member('hurt',19999),member('full',20000),member('dead',0)];
  const result=recovery.use(bag,entry(),party,'player',{},()=>0);
  assert.deepEqual(result,{used:true,amount:2400,healed:['hurt'],effects:['hurt','full']});
  assert.equal(party[1].player.health,20000);assert.equal(party[3].player.health,0);
});
test('full party, sleeping user and potion sickness do not consume or start cooldown',()=>{
  const {bag,recovery,entry}=setup(),player=member('player',20000);
  assert.deepEqual(recovery.use(bag,entry(),[player],'player'),{used:false,reason:'full-health'});
  player.player.health=1;
  for(const modifiers of [{sleeping:true},{potionSickness:true}])assert.deepEqual(recovery.use(bag,entry(),[player],'player',modifiers),{used:false,reason:'blocked'});
  player.player.health=0;
  assert.deepEqual(recovery.use(bag,entry(),[player],'player'),{used:false,reason:'unavailable'});
  assert.equal(bag.count(potions[0][0]),3);assert.equal(recovery.cooldown.cooling,false);
});
test('shared cooldown survives switching potion and user, with strict native frame boundary',()=>{
  const {bag,recovery,entry}=setup(),party=[member('player',1),member('ally',1)];
  assert.ok(recovery.use(bag,entry(),party,'player').used);
  recovery.advance(9899);
  assert.equal(recovery.use(bag,entry(1),party,'ally').used,false);
  recovery.advance(1);
  assert.deepEqual(recovery.cooldown,{remainingMs:0,durationMs:9900,cooling:true});
  recovery.advance(59);
  assert.equal(recovery.use(bag,entry(1),party,'ally').used,false);
  recovery.advance(1);
  assert.ok(recovery.use(bag,entry(1),party,'ally').used);
});
test('potion sickness blocks one-shot potions but never the regeneration group',()=>{
  const regeneration=Object.entries(catalog.items).find(([,item])=>item.use?.kind==='regenerate')!;
  const {bag,recovery}=setup();
  bag.add(regeneration[0]);
  const entry=bag.entries.find(item=>item.item===regeneration[0])!.id;
  const result=recovery.use(bag,entry,[member('player',1)],'player',{potionSickness:true});
  assert.ok(result.used);
  const {bag:once,recovery:onceRecovery,entry:oneShot}=setup();
  assert.deepEqual(onceRecovery.use(once,oneShot(),[member('player',1)],'player',{potionSickness:true}),
    {used:false,reason:'blocked'});
});

test('native weakening happens before ten-percent bonus and reduced cooldown retains mask denominator',()=>{
  const {bag,recovery,entry}=setup(),party=[member('player',1)];
  const result=recovery.use(bag,entry(),party,'player',{weakened:true,recoveryBonus:true,cooldownReductionMs:2700},()=>0);
  assert.ok(result.used);assert.equal(result.amount,1320);
  assert.deepEqual(recovery.cooldown,{remainingMs:7200,durationMs:9900,cooling:true});
  recovery.advance(7200);assert.equal(recovery.cooldown.cooling,true);
  recovery.advance(60);assert.equal(recovery.cooldown.cooling,false);
});
test('session owns cooldown across world consumers; new sessions have independent clocks',()=>{
  const session=new Session(parseCampaign(read('campaign')),undefined,undefined,catalog);
  const entry=session.bag.entries.find(item=>item.item===catalog.startingShortcut)!;
  assert.ok(session.recovery.use(session.bag,entry.id,[member('player',1)],'player').used);
  const before=session.recovery.cooldown;
  session.advanceGameTime(0);assert.deepEqual(session.recovery.cooldown,before);
  session.advanceGameTime(600);assert.equal(session.recovery.cooldown.remainingMs,9300);
  assert.equal(new RecoveryItems().cooldown.cooling,false);
});
test('generic bag use cannot bypass recovery checks; last potion clears shortcut',()=>{
  const {bag,recovery,entry}=setup(),id=entry();
  assert.throws(()=>bag.use(id),new RegExp(USE_INTERFACE_ONLY));assert.equal(bag.get(id)!.quantity,3);
  const shortcuts=ShortcutBar.for(bag,'player',[]);
  bag.take(id,2);shortcuts.assign(0,5,{kind:'item',id:potions[0][0]});
  assert.ok(recovery.use(bag,id,[member('player',1)],'player').used);
  assert.equal(bag.count(potions[0][0]),0);
  assert.equal(shortcuts.page(0)[5],null,'用完的消耗品会从快捷栏上撤掉');
});
test('content rejects missing, inverted and off-frame recovery definitions',()=>{
  for(const change of [(use:any)=>delete use.recovery,
    // 比例式回复的比例必须在 0~100 之间——这是新的联合类型带出来的校验。
    (use:any)=>use.recovery={mode:'rate',ratePercent:0,restoresMana:false,cooldownMs:9900},
    (use:any)=>use.recovery.cooldownMs=9901]){
    const value=structuredClone(catalog);change(value.items[potions[0][0]].use);
    assert.throws(()=>parseItemCatalog(value));
  }
});

test('using the other consumable group retains the party recovery cooldown',()=>{
  const {bag,recovery,entry}=setup();
  const shortcuts=ShortcutBar.for(bag,'player',[]);
  shortcuts.assign(0,5,{kind:'item',id:potions[0][0]});shortcuts.assign(1,5,{kind:'item',id:potions[1][0]});
  const members=[member('player',1)];
  assert.ok(recovery.use(bag,entry(),members,'player').used);
  const other=bag.entries.find(item=>item.item===shortcuts.page(1)[5]!.id)!;
  assert.deepEqual(recovery.use(bag,other.id,members,'player'),{used:false,reason:'cooldown'});
  assert.equal(bag.count(other.item),3);
});
