import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

function fixture(){
  const conditions=new CombatConditions(),applied:{id:string;key:string}[]=[],requests:number[]=[];
  const member={classId:'dark-knight',level:10,
    bag:{equipmentFor:()=>({}),get:()=>undefined,equipmentItems:()=>({})},
    panel:{physicalAttack:10,magicAttack:10,maxHealth:100,maxMana:100},
    player:{health:1,maxHealth:100,mana:0,maxMana:100},setHealth(){},setMana(){}};
  const party={controlledId:'player',groupModifiers:()=>({})};
  const host=Object.setPrototypeOf({
    scene:{canCombatControl:true,player:{container:{active:true}}},
    closed:false,defeated:false,castingSkill:false,conditions,hero:member,
    app:{battleCatalog:catalog,suspended:false,session:{party,skills:{isEquipped:()=>true}}},
    memberOf:(id:string)=>id==='player'?member:undefined,
    activeParty:['player'],
    applyActorBuff:(id:string,key:string)=>{applied.push({id,key});return true;},
    runtime:{request:()=>requests.push(1)},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  return {conditions,party,applied,requests,call};
}

test('spring state buffs land only on the currently controlled character',()=>{
  const f=fixture();
  f.call('applySpringBuff','spring-potion-sickness');
  assert.deepEqual(f.applied,[{id:'player',key:'spring-potion-sickness'}]);
  f.party.controlledId='ally';
  f.call('applySpringBuff','spring-skill-seal');
  assert.deepEqual(f.applied,[{id:'player',key:'spring-potion-sickness'},{id:'ally',key:'spring-skill-seal'}]);
});

test('shortcut seal blocks skill input and the skill slot before the runtime request',()=>{
  const f=fixture();
  f.conditions.applyState('player','shortcut-sealed',1000);
  f.call('attack','shield-bash');
  assert.deepEqual(f.requests,[]);
  assert.equal(f.call('skillSlotAvailable','shield-bash'),false);
  f.conditions.removeState('player','shortcut-sealed');
  assert.equal(f.conditions.canUseSkillShortcuts('player'),true);
});
