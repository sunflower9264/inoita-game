import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBattle } from '../src/application/content-validation.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import { calculateEnemy } from '../src/domain/enemy-stats.ts';

const read=()=>JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const catalog=parseBattle(read());
const example=()=>({...structuredClone(catalog.enemies[3]),level:20,maxHealth:101,
  attributes:{...catalog.enemies[3].attributes,physicalAttack:7,magicAttack:7,evasionBonus:0}});

test('all 553 monster definitions have complete integer attributes and safe snapshots through maximum boosts',()=>{
  assert.equal(catalog.enemies.length,553);
  assert.equal(catalog.enemies.filter(e=>e.level===null).length,3);
  assert.equal(Math.max(...catalog.enemies.map(e=>e.level??1)),107);
  for(const enemy of catalog.enemies){
    assert.equal(Object.keys(enemy.attributes).length,15);
    for(const value of Object.values(enemy.attributes))assert.ok(Number.isInteger(value)&&value>=0);
    const stats=calculateEnemy(enemy,{level:107,elite:true,partySize:3,playerLevel:105});
    for(const value of Object.values(stats).filter(v=>typeof v==='number'))assert.ok(Number.isSafeInteger(value));
    assert.ok(stats.maxHealth>0);assert.ok(stats.magicResistance<=750);assert.ok(stats.evasionRate<=750);
  }
});

test('monster level changes hit/evasion bases and experience without invented health or attack growth',()=>{
  const enemy=example(),low=calculateEnemy(enemy,{level:1}),high=calculateEnemy(enemy,{level:107});
  assert.deepEqual([low.hitBase,low.evasionBase,low.hitRate,low.evasionRate],[44,11,900,174]);
  assert.deepEqual([high.hitBase,high.evasionBase,high.hitRate,high.evasionRate],[468,117,900,172]);
  assert.equal(low.maxHealth,high.maxHealth);assert.equal(low.physicalAttack,high.physicalAttack);
  assert.equal(calculateEnemy(catalog.enemies[0],{sceneLevel:50}).level,50);
  assert.equal(calculateEnemy(catalog.enemies[0]).sceneLevel,true);
  assert.equal(calculateEnemy(catalog.enemies[0],{level:3}).sceneLevel,false);
});

test('elite then party multipliers truncate each step and party leaves magic attack untouched',()=>{
  const enemy=example(),stats=calculateEnemy(enemy,{elite:true,partySize:3});
  assert.equal(stats.maxHealth,508); // trunc(101 * 3.6) = 363; trunc(363 * 1.4) = 508
  assert.equal(stats.physicalAttack,11); // trunc(7 * 1.2) = 8; trunc(8 * 1.4) = 11
  assert.equal(stats.magicAttack,8);
  assert.equal(calculateEnemy(enemy,{partySize:2}).magicAttack,7);
  assert.equal(enemy.maxHealth,101);assert.equal(enemy.attributes.physicalAttack,7);
  const rates=calculateEnemy({...enemy,attributes:{...enemy.attributes,magicResistance:900,evasionBonus:900,physicalResistanceBonus:800}});
  assert.equal(rates.magicResistance,750);assert.equal(rates.evasionRate,750);assert.equal(rates.physicalResistance,800);
});

test('experience uses original attack/health, alive party count and clamped main-player level difference',()=>{
  const enemy=example();
  assert.equal(calculateEnemy(enemy,{playerLevel:20}).experience,171);
  assert.equal(calculateEnemy(enemy,{elite:true,partySize:3,playerLevel:20}).experience,102);
  assert.equal(calculateEnemy(enemy,{playerLevel:1}).experience,256);
  assert.equal(calculateEnemy(enemy,{playerLevel:105}).experience,34);
  assert.equal(calculateEnemy(enemy,{partySize:2,playerLevel:18}).experience,163);
  const tiny={...enemy,maxHealth:1,attributes:{...enemy.attributes,physicalAttack:0}};
  assert.equal(calculateEnemy(tiny,{partySize:3}).experience,0);
});

test('enemy movement and party scaling preserve resources, snapshots and unrelated instances',()=>{
  const enemy=example(),config=new EnemyRoster(),a=config.placeEnemy(enemy.id,1,2),b=config.placeEnemy(enemy.id,4,5);
  config.setEnemyHealth(a.key,50,enemy);const original=config.enemySnapshot(a.key,enemy)!;
  assert.equal(config.enemyStatus(b.key,enemy)!.health,101);
  config.moveEnemy(a.key,100,200);
  assert.equal(config.enemySnapshot(a.key,enemy)!.level,20);assert.equal(config.enemyStatus(a.key,enemy)!.health,50);
  assert.equal(original.maxHealth,101);assert.equal(original.health,50);assert.ok(Object.isFrozen(original));
  config.setEnemyHealth(a.key,0,enemy);config.setPartySize(3,[enemy]);
  assert.equal(config.enemyStatus(a.key,enemy)!.health,0);assert.equal(config.enemyStatus(b.key,enemy)!.health,141);
  assert.equal(config.enemySnapshot(a.key,enemy)!.elite,false);assert.equal(config.enemyStatus(a.key,enemy)!.health,0);
  config.removeEnemy(a.key);assert.equal(config.enemySnapshot(a.key,enemy),undefined);
});

test('enemy mana drains per instance, clamps to its source maximum, and disappears with the instance',()=>{
  const enemy={...example(),attributes:{...example().attributes,maxMana:73}};
  const config=new EnemyRoster(),a=config.placeEnemy(enemy.id,1,2),b=config.placeEnemy(enemy.id,4,5);
  assert.equal(config.enemySnapshot(a.key,enemy)!.mana,73);
  config.setEnemyMana(a.key,55,enemy);
  assert.equal(config.enemySnapshot(a.key,enemy)!.mana,55);
  assert.equal(config.enemySnapshot(b.key,enemy)!.mana,73);
  config.setEnemyMana(a.key,-1,enemy);assert.equal(config.enemySnapshot(a.key,enemy)!.mana,0);
  config.setEnemyMana(a.key,999,enemy);assert.equal(config.enemySnapshot(a.key,enemy)!.mana,73);
  config.removeEnemy(a.key);assert.equal(config.enemySnapshot(a.key,enemy),undefined);
});

test('party size changes preserve derived summon health',()=>{
  const enemy=example(),roster=new EnemyRoster(),summon=roster.placeEnemy(enemy.id,0,0);
  summon.summonedBy='player';
  summon.summonedStats={maxHealth:3520,physicalResistanceBonus:0,magicResistance:0};
  roster.setEnemyHealth(summon.key,1760,enemy);
  roster.setPartySize(2,[enemy]);
  assert.equal(roster.enemySnapshot(summon.key,enemy)!.health,1760);
  roster.setPartySize(1,[enemy]);
  assert.equal(roster.enemySnapshot(summon.key,enemy)!.health,1760);
});

test('reducing party size preserves living, defeated and untouched enemy states',()=>{
  const enemy=example(),roster=new EnemyRoster();
  roster.setPartySize(3,[enemy]);
  const wounded=roster.placeEnemy(enemy.id,1,1),dead=roster.placeEnemy(enemy.id,2,2),full=roster.placeEnemy(enemy.id,3,3);
  roster.setEnemyHealth(wounded.key,1,enemy);roster.setEnemyHealth(dead.key,0,enemy);
  roster.setPartySize(1,[enemy]);
  assert.equal(roster.enemySnapshot(wounded.key,enemy)!.health,1);
  assert.equal(roster.enemySnapshot(dead.key,enemy)!.health,0);
  assert.equal(roster.enemySnapshot(full.key,enemy)!.health,enemy.maxHealth);
  assert.equal(full.health,undefined);
  assert.equal(roster.enemies.length,3);
});

test('party changes publish all updated enemies once and invalid inputs leave state unchanged',()=>{
  const enemy=example(),config=new EnemyRoster(),a=config.placeEnemy(enemy.id,0,0),b=config.placeEnemy(enemy.id,1,1);
  config.setEnemyHealth(a.key,50,enemy);let notices=0;
  const unsubscribe=config.subscribeEnemies(()=>{
    notices++;assert.equal(config.partySize,3);
    assert.equal(config.enemyStatus(a.key,enemy)!.maxHealth,141);assert.equal(config.enemyStatus(a.key,enemy)!.health,69);
    assert.equal(config.enemyStatus(b.key,enemy)!.health,141);
  });
  assert.throws(()=>config.setPartySize(3,[]),/缺失/);assert.equal(config.partySize,1);assert.equal(a.health,50);
  for(const value of [0,4,1.5,NaN,Infinity])assert.throws(()=>config.setPartySize(value,[enemy]));
  assert.equal(notices,0);config.setPartySize(3,[enemy]);assert.equal(notices,1);
  config.setPartySize(3,[enemy]);config.setEnemyHealth(a.key,69,enemy);assert.equal(notices,1);
  unsubscribe();config.setEnemyHealth(a.key,10,enemy);assert.equal(notices,1);
});

test('runtime and build content validator reject missing, invalid and unknown monster fields',()=>{
  const missing=read();delete missing.enemies[0].attributes;assert.throws(()=>parseBattle(missing),/attributes/);
  const extra=read();extra.enemies[0].attributes.u_15=1;assert.throws(()=>parseBattle(extra),/u_15/);
  for(const value of [-1,0.5,NaN,Infinity]){const bad=read();bad.enemies[0].attributes.physicalAttack=value;assert.throws(()=>parseBattle(bad),/physicalAttack/);}
  for(const value of [0,108,1.5,Infinity]){const bad=read();bad.enemies[0].level=value;assert.throws(()=>parseBattle(bad),/level/);}
  for(const value of [0,-1,1.5]){const bad=read();bad.enemies[0].maxHealth=value;assert.throws(()=>parseBattle(bad),/maxHealth/);}
});
