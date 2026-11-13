import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseDrops, rollReservedDrops, type DropCatalog, type DropReward, type ReservedDropConfig } from '../src/domain/drops.ts';
import { parseItemCatalog } from '../src/application/content-validation.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { Session } from '../src/domain/session.ts';
import type { Campaign } from '../src/domain/campaign.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = parseItemCatalog(read('items'));
const rawDrops = read<DropCatalog>('drops');
const drops = parseDrops(rawDrops, items, Object.keys(rawDrops.enemies));
const campaign = read<Campaign>('campaign');
const stats = read<CharacterStatsCatalog>('character-stats');
const itemOf = (rewards: DropReward[]): string | undefined => rewards[0]?.kind === 'item' ? rewards[0].item : undefined;

test('shipped reserved drop table covers every blocked item and only uses elite/boss sources', () => {
  const config = drops.reservedDrops!;
  assert.equal(config.version, 1);
  assert.equal(config.sources.elite.chancePer10000, 45);
  assert.equal(config.sources.boss.chancePer10000, 55);
  assert.equal(config.pity.unlockGuaranteeAfter, 25);
  assert.equal(config.entries.length, 230);
  assert.ok(config.entries.every(entry => entry.sources.every(source => source === 'elite' || source === 'boss')));
  const flagged = Object.entries(rawDrops.enemies).filter(([, rule]) => rule.paidDropEligible);
  assert.equal(flagged.length, 18);
  assert.ok(flagged.every(([, rule]) => rule.level <= 58));
});

const syntheticConfig: ReservedDropConfig = {
  version: 1,
  sources: { elite: { chancePer10000: 10000 }, boss: { chancePer10000: 0 } },
  pity: { unlockGuaranteeAfter: 3 },
  entries: [
    { item: 'once-item', minPlayerLevel: 10, maxPlayerLevel: 20, sources: ['elite'], weight: 100, once: true, softMax: true },
    { item: 'repeat-item', minPlayerLevel: 1, maxPlayerLevel: 105, sources: ['elite'], weight: 100, once: false }
  ]
};
const syntheticDrops = { ...drops, reservedDrops: syntheticConfig } as DropCatalog;
const plainStats = { equipment: {}, grades: [] } as unknown as CharacterStatsCatalog;

test('level gates, forced unlock pity, claimed and pending one-time items', () => {
  const low = rollReservedDrops(syntheticDrops, plainStats, { source: 'elite', heroLevel: 5, random: () => 0 });
  assert.equal(itemOf(low.rewards), 'repeat-item');
  assert.equal(low.unlockMisses, 0);

  const forced = rollReservedDrops(syntheticDrops, plainStats, { source: 'elite', heroLevel: 15, unlockMisses: 2, random: () => 0 });
  assert.equal(forced.forced, true);
  assert.equal(itemOf(forced.rewards), 'once-item');
  assert.equal(forced.unlockMisses, 3);

  const claimed = rollReservedDrops(syntheticDrops, plainStats, { source: 'elite', heroLevel: 15, unlockMisses: 2, claimed: new Set(['once-item']), random: () => 0 });
  assert.equal(claimed.forced, false);
  assert.equal(itemOf(claimed.rewards), 'repeat-item');

  const pending = rollReservedDrops(syntheticDrops, plainStats, { source: 'elite', heroLevel: 15, unlockMisses: 2, pending: new Set(['once-item']), random: () => 0 });
  assert.equal(pending.forced, false);
  assert.equal(itemOf(pending.rewards), 'repeat-item');
});

test('soft max keeps one-time unlocks reachable, hard max closes repeatable entries', () => {
  const soft = rollReservedDrops(syntheticDrops, plainStats, { source: 'elite', heroLevel: 50, unlockMisses: 2, random: () => 0 });
  assert.equal(soft.forced, true);
  assert.equal(itemOf(soft.rewards), 'once-item');
  const hard = { ...syntheticDrops, reservedDrops: { ...syntheticConfig, entries: [{ ...syntheticConfig.entries[1]!, maxPlayerLevel: 20 }] } } as DropCatalog;
  assert.equal(rollReservedDrops(hard, plainStats, { source: 'elite', heroLevel: 50, random: () => 0 }).rewards.length, 0);
});

test('reserved equipment rewards carry a static grade snapshot', () => {
  const config: ReservedDropConfig = {
    version: 1,
    sources: { elite: { chancePer10000: 10000 }, boss: { chancePer10000: 0 } },
    pity: { unlockGuaranteeAfter: 25 },
    entries: [{ item: 'black-sword-2', minPlayerLevel: 1, maxPlayerLevel: 105, sources: ['elite'], weight: 100, once: false }]
  };
  const result = rollReservedDrops({ ...drops, reservedDrops: config } as DropCatalog, stats, { source: 'elite', heroLevel: 10, random: () => 0 });
  const reward = result.rewards[0];
  assert.equal(reward?.kind, 'item');
  if (reward?.kind === 'item') assert.ok(reward.roll, '装备掉落需要带品级快照');
});

test('sealed equipment box drops only when its source level has suitable contents',()=>{
  const entry=drops.reservedDrops!.entries.find(value=>value.item==='sealed-necklace-chest')!;
  const config={...drops.reservedDrops!,sources:{elite:{chancePer10000:10000},boss:{chancePer10000:10000}},entries:[entry]};
  const catalog={...drops,reservedDrops:config};
  const low=rollReservedDrops(catalog,stats,{source:'elite',heroLevel:105,sourceLevel:38,unlockMisses:24,random:()=>0});
  assert.deepEqual(low.rewards,[]);
  assert.equal(low.unlockMisses,24);
  const high=rollReservedDrops(catalog,stats,{source:'elite',heroLevel:20,sourceLevel:100,random:()=>0});
  assert.equal(high.rewards[0]?.kind,'item');
  if(high.rewards[0]?.kind==='item')assert.equal(high.rewards[0].lootLevel,100);
});

test('a failed base roll still advances the unlock pity counter', () => {
  const miss = { ...syntheticDrops, reservedDrops: { ...syntheticConfig, sources: { elite: { chancePer10000: 0 }, boss: { chancePer10000: 0 } } } } as DropCatalog;
  const result = rollReservedDrops(miss, plainStats, { source: 'elite', heroLevel: 15, unlockMisses: 0, random: () => 0 });
  assert.deepEqual(result.rewards, []);
  assert.equal(result.unlockMisses, 1);
});

test('session claim resets unlock pity and seeded claims stay in the set', () => {
  const session = new Session(campaign, undefined, undefined, items);
  session.reservedDropMisses = 7;
  session.claimReservedDrop('once-item');
  assert.equal(session.reservedDropMisses, 0);
  assert.ok(session.claimedReservedDrops.has('once-item'));
  session.seedReservedClaims(['second-once']);
  assert.ok(session.claimedReservedDrops.has('second-once'));
});

test('reserved drop state survives session capture and restore', () => {
  const session = new Session(campaign, undefined, undefined, items);
  session.reservedDropMisses = 4;
  session.seedReservedClaims(['once-a', 'once-b']);
  const restored = new Session(campaign, undefined, undefined, items);
  restored.restoreState(session.captureState());
  assert.equal(restored.reservedDropMisses, 4);
  assert.deepEqual([...restored.claimedReservedDrops].sort(), ['once-a', 'once-b']);
});
