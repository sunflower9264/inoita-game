import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { WorldIndex } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { innRestQuote, restAtInn } from '../src/domain/inns.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import { GameUI } from '../src/ui/game-ui.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle'),companions=read<CompanionCatalog>('companions'),world=read<WorldIndex>('world');
function createSession():Session {
  const hero=new BattleCharacter('dark-knight',stats,items);
  return new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
}

test('inn rest cost counts living active members and restores their HP and MP',()=>{
  const session=createSession(),hero=session.hero!,party=session.party!;
  const member=party.joinStory('mercenary-portia');
  hero.setHealth(1);hero.setMana(1);member.setHealth(1);member.setMana(1);
  const quote=innRestQuote(session);
  assert.deepEqual(quote,{cost:2*hero.level,members:['player',member.id]});
  restAtInn(session,quote);
  assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(hero.player.mana,hero.player.maxMana);
  assert.equal(member.player.health,member.player.maxHealth);assert.equal(member.player.mana,member.player.maxMana);
});

test('a fallen member is excluded from the cost and is not revived',()=>{
  const session=createSession(),hero=session.hero!,party=session.party!;
  const member=party.joinStory('mercenary-portia');
  hero.setHealth(1);member.setHealth(0);
  const quote=innRestQuote(session);
  assert.deepEqual(quote,{cost:hero.level,members:['player']});
  restAtInn(session,quote);
  assert.equal(hero.player.health,hero.player.maxHealth);
  assert.equal(member.player.health,0);
});

test('innkeeper confirmation charges once and cancellation changes nothing',async()=>{
  const session=createSession(),hero=session.hero!,party=session.party!;
  const member=party.joinStory('mercenary-portia');
  hero.setHealth(1);member.setHealth(1);
  const quote=innRestQuote(session);
  session.gainMoney(quote.cost);
  const ui=new GameUI(),director=new StoryDirector(campaign,session,ui,locked=>ui.lock(locked));
  const actor=world.actors['innkeeper-ad05fa66'];
  const rest=()=>{session.transaction(()=>{session.spendMoney(quote.cost);restAtInn(session,quote);});};
  const cancelled=director.visitInnkeeper(actor,quote,rest);
  assert.equal(ui.locked,true);assert.match(ui.choices!.description,new RegExp(String(quote.cost)));
  ui.choices!.choose(ui.choices!.options[1]);assert.equal(await cancelled,true);
  assert.equal(session.money,quote.cost);assert.equal(hero.player.health,1);assert.equal(ui.locked,false);
  const confirmed=director.visitInnkeeper(actor,quote,rest);
  ui.choices!.choose(ui.choices!.options[0]);assert.equal(await confirmed,true);
  assert.equal(session.money,0);assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(member.player.health,member.player.maxHealth);
  assert.equal(ui.locked,false);
});
