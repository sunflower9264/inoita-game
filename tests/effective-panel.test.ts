import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {effectiveCharacterPanel, type CharacterPanel} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {memberCombatModifiers} from '../src/domain/party-combat.ts';
import type {PassiveModifier} from '../src/domain/passive-skills.ts';
import {calculateEffectiveDefense} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const panel:CharacterPanel={attributes:{strength:10,dexterity:10,vitality:10,intelligence:10,mentality:10},
  maxHealth:1000,maxMana:200,physicalAttack:100,magicAttack:100,criticalRate:30,hitRate:200,
  baseDefense:100,baseMagicResistance:0,criticalDamage:1000,defense:100,defenseRate:0,
  physicalResistance:555,magicResistance:0,evasionRate:200,weaponBlock:30,shieldBlock:0,offhandShield:false,
  hitBase:100,hitBonus:0,evasionBase:10,evasionBonus:0,criticalResistance:0,criticalDamageResistance:0};
const add=(attribute:PassiveModifier['attribute'],amount:number):PassiveModifier=>({attribute,operation:{kind:'add',amount}});

test('permanent modifiers reach the displayed magic resistance without changing the base value',()=>{
  const effective=effectiveCharacterPanel(panel,1,[add('magicResistance',30)]);
  assert.equal(effective.magicResistance,30);
  assert.equal(effective.baseMagicResistance,0,'战斗仍从基础值重新叠加');
  assert.equal(effectiveCharacterPanel({...panel,baseMagicResistance:800},1,[add('magicResistance',30)]).magicResistance,750);
});

test('defense, hit, evasion and block modifiers use the same final formulas as combat',()=>{
  const modifiers=[add('defense',50),{attribute:'defenseRate',operation:{kind:'add',amount:1000}} as PassiveModifier,
    add('physicalResistanceBonus',45),add('hitBonus',100),add('evasionBonus',100),add('weaponBlock',20),add('shieldBlock',10)];
  const effective=effectiveCharacterPanel(panel,1,modifiers);
  assert.equal(effective.baseDefense,100);
  assert.equal(effective.defense,300);
  assert.equal(effective.physicalResistance,834);
  assert.ok(effective.hitRate>panel.hitRate);
  assert.ok(effective.evasionRate>panel.evasionRate);
  assert.equal(effective.weaponBlock,50);
  assert.equal(effective.shieldBlock,10);
  const conditions=new CombatConditions();
  const fighter=conditions.fighter('player',{level:1,physicalAttack:panel.physicalAttack,defense:panel.baseDefense,defenseRate:panel.defenseRate,
    magicAttack:panel.magicAttack,maxHealth:panel.maxHealth,hitBase:panel.hitBase,hitBonus:panel.hitBonus,evasionBase:panel.evasionBase,
    evasionBonus:panel.evasionBonus,criticalRate:panel.criticalRate,criticalResistance:panel.criticalResistance,
    criticalDamage:panel.criticalDamage,criticalDamageResistance:panel.criticalDamageResistance,weaponBlock:panel.weaponBlock,
    shieldBlock:panel.shieldBlock,physicalResistance:panel.physicalResistance,magicResistance:panel.baseMagicResistance},modifiers);
  assert.equal(fighter.magicResistance,effective.magicResistance);
  assert.equal(fighter.physicalResistance,effective.physicalResistance);
  assert.equal(calculateEffectiveDefense(fighter.defense!,fighter.defenseRate!),effective.defense);
  assert.equal(fighter.hitBonus,effective.hitBonus);
  assert.equal(fighter.evasionBonus,effective.evasionBonus);
});

test('member modifiers combine class passives with party group skills',()=>{
  const modifiers=memberCombatModifiers({catalog,classId:'warrior',loadout:{levels:{'skin-of-steel':1}},
    weaponKind:'unarmed',armorKind:'',health:100,maxHealth:100,groupEffects:{'magic-resistance':30}});
  assert.ok(modifiers.some(modifier=>modifier.attribute==='magicResistance'&&modifier.operation.kind==='add'&&modifier.operation.amount===45));
  assert.ok(modifiers.some(modifier=>modifier.attribute==='magicResistance'&&modifier.operation.kind==='add'&&modifier.operation.amount===30));
  assert.equal(effectiveCharacterPanel(panel,1,modifiers).magicResistance,75);
});
