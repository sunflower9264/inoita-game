import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NavigationWorld, type NavigationActor, type Placement } from '../src/domain/navigation-world.ts';
import { choosePartyLanding } from '../src/domain/party-placement.ts';
import { canStandOnTerrain } from '../src/domain/navigation.ts';

const openMap = () => ({ name: 'test', columns: 20, rows: 20, tileSize: 16, blocked: Array(400).fill(false) as boolean[] });
function actorAt(x: number, y: number, visible = true): NavigationActor {
  const point = { x, y };
  return { shape: () => ({ collision: { x: -8, y: -8, width: 16, height: 16 } }), position: () => point, enabled: () => visible };
}

test('party members do not block each other while hostiles still do', () => {
  const navigation = new NavigationWorld(openMap());
  const hero = { ...actorAt(0, 0), faction: () => 'party' as const };
  const companion = { ...actorAt(100, 100), faction: () => 'party' as const };
  const enemy = { ...actorAt(100, 100), faction: () => 'hostile' as const };
  navigation.register(hero); navigation.register(companion);
  assert.equal(navigation.canPlaceAll([{ actor: hero, position: { x: 100, y: 100 } }]), true, '队友之间可以重叠');
  navigation.register(enemy);
  assert.equal(navigation.canPlaceAll([{ actor: hero, position: { x: 100, y: 100 } }]), false, '敌人仍然阻挡');
});

test('an authoritative placement displaces whoever already stands there', () => {
  const navigation = new NavigationWorld(openMap());
  const arriving = actorAt(0, 0), standing = actorAt(100, 100);
  navigation.register(arriving); navigation.register(standing);
  const target = { x: 100, y: 100 };
  assert.equal(navigation.canPlaceAll([{ actor: arriving, position: target }]), false);

  const evicted = navigation.evictionsFor([{ actor: arriving, position: target }]);
  assert.equal(evicted.length, 1); assert.equal(evicted[0].actor, standing);
  assert.notDeepEqual(evicted[0].position, target);
  assert.equal(navigation.canPlaceAll([{ actor: arriving, position: target }, { actor: standing, position: evicted[0].position }]), true);
});

test('two authoritative placements that overlap still fail instead of silently moving', () => {
  const navigation = new NavigationWorld(openMap());
  const first = actorAt(0, 0), second = actorAt(0, 0);
  navigation.register(first); navigation.register(second);
  const placements = [{ actor: first, position: { x: 100, y: 100 } }, { actor: second, position: { x: 100, y: 100 } }];
  assert.deepEqual(navigation.evictionsFor(placements), []);
  assert.equal(navigation.canPlaceAll(placements), false);
});

test('a displaceable target yields only when it actually collides with an authoritative one', () => {
  const navigation = new NavigationWorld(openMap());
  const npc = actorAt(0, 0), hero = actorAt(0, 0);
  navigation.register(npc); navigation.register(hero);
  const displaceable = new Set([hero]);

  const blocked = navigation.evictionsFor([{ actor: npc, position: { x: 100, y: 100 } }, { actor: hero, position: { x: 100, y: 100 } }], displaceable);
  assert.equal(blocked.length, 1); assert.equal(blocked[0].actor, hero);
  assert.equal(navigation.canPlaceAll([{ actor: npc, position: { x: 100, y: 100 } }, { actor: hero, position: blocked[0].position }]), true);

  const clear = navigation.evictionsFor([{ actor: npc, position: { x: 100, y: 100 } }, { actor: hero, position: { x: 300, y: 300 } }], displaceable);
  assert.deepEqual(clear, []);
});

test('a hidden standby does not block an authoritative placement', () => {
  const navigation = new NavigationWorld(openMap());
  const arriving = actorAt(0, 0), hidden = actorAt(100, 100, false);
  navigation.register(arriving); navigation.register(hidden);
  assert.deepEqual(navigation.evictionsFor([{ actor: arriving, position: { x: 100, y: 100 } }]), []);
  assert.equal(navigation.canPlaceAll([{ actor: arriving, position: { x: 100, y: 100 } }]), true);
});

test('blocked terrain still rejects the authoritative placement itself', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const arriving = actorAt(0, 0); navigation.register(arriving);
  const target = { x: 104, y: 104 };
  assert.equal(navigation.canPlace(actorAt(0, 0).shape(), target), false);
  assert.equal(navigation.canPlaceAll([{ actor: arriving, position: target }]), false);
});

test('standstill entities settle without inspection, including ones on blocked terrain or sharing a cell', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const decoration = actorAt(104, 104);          // 无碰撞盒的装饰，位置本就压在阻挡格上
  const first = actorAt(100, 100), second = actorAt(100, 100);  // 同格的两个实体，按剧情阶段显隐
  navigation.register(decoration); navigation.register(first); navigation.register(second);
  assert.equal(navigation.canSettleAll([{ actor: decoration, position: { x: 104, y: 104 }, enabled: true }]), true);
  assert.equal(navigation.canSettleAll([
    { actor: first, position: { x: 100, y: 100 }, enabled: true },
    { actor: second, position: { x: 100, y: 100 }, enabled: true }]), true);
});

test('an entity that actually has to move is still inspected', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const mover = actorAt(200, 200); navigation.register(mover);
  assert.equal(navigation.canSettleAll([{ actor: mover, position: { x: 104, y: 104 }, enabled: true }]), false, '移动到阻挡格必须被拒绝');
  assert.equal(navigation.canSettleAll([{ actor: mover, position: { x: 240, y: 240 }, enabled: true }]), true);
});

test('a hidden entity settles regardless of where it stands', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const hidden = actorAt(200, 200); navigation.register(hidden);
  assert.equal(navigation.canSettleAll([{ actor: hidden, position: { x: 104, y: 104 }, enabled: false }]), true);
});

test('a controllable actor is inspected even when unchanged or hidden', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  // 内容实体保持可信坐标；主角/佣兵同样的坐标必须按整盒复核。
  const contentNavigation = new NavigationWorld(map), content = actorAt(104, 104);
  contentNavigation.register(content);
  assert.equal(contentNavigation.canSettleAll([{ actor: content, position: { x: 104, y: 104 }, enabled: true }]), true);

  const navigation = new NavigationWorld(map), strict = { ...actorAt(104, 104), strictTerrain: () => true };
  navigation.register(strict);
  assert.equal(navigation.canSettleAll([{ actor: strict, position: { x: 104, y: 104 }, enabled: true }]), false);
  assert.equal(navigation.canSettleAll([{ actor: strict, position: { x: 104, y: 104 }, enabled: false }]), false,
    '隐藏时的非法写入同样要拦住');
  assert.equal(navigation.canSettleAll([{ actor: strict, position: { x: 240, y: 240 }, enabled: true }]), true);
});

test('召唤落点按整个碰撞盒判定：锚点站在墙边、身体压进阻挡格会被拒绝', () => {
  const map = openMap(); map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const body = { x: -8, y: -8, width: 16, height: 16 }, anchor = { x: 90, y: 104 };
  assert.equal(navigation.canPlace({ collision: body }, anchor), true, '窄足底口径只看锚点 ±4 像素');
  assert.equal(navigation.canPlaceBody({ collision: body }, anchor), false, '整盒口径要求身体也不压阻挡格');
});

test('整盒就近落点绕开已站立实体，整张地图都放不下时返回 undefined', () => {
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const navigation = new NavigationWorld(openMap());
  const standing = actorAt(200, 200); navigation.register(standing);
  const spot = navigation.nearestBody({ collision: body }, { x: 200, y: 200 });
  assert.notDeepEqual(spot, { x: 200, y: 200 }, '不和已站立的实体重叠');
  assert.equal(navigation.canPlaceBody({ collision: body }, spot!), true);

  const sealed = new NavigationWorld({ ...openMap(), blocked: Array(400).fill(true) });
  assert.equal(sealed.nearestBody({ collision: body }, { x: 100, y: 100 }), undefined, '没有可站处就不给落点');
  assert.throws(() => sealed.nearest({ collision: body }, { x: 100, y: 100 }), /地图没有可通行区域/, 'nearest 保持抛错契约');
});

test('落点搜索预算耗尽会单独上报，不和真的不可达混在一起', () => {
  const records: { kind: string; details: unknown }[] = [];
  const previous = (globalThis as { storyDiagnostics?: unknown }).storyDiagnostics;
  (globalThis as unknown as { storyDiagnostics: { record(kind: string, details: unknown): void } }).storyDiagnostics = {
    record: (kind, details) => records.push({ kind, details })
  };
  try {
    const navigation = new NavigationWorld(openMap());
    const huge = { collision: { x: -1000, y: -1000, width: 2000, height: 2000 } };
    assert.equal(navigation.nearestReachableBody(huge, { x: 100, y: 100 }), undefined);
    assert.equal(records.at(-1)?.kind, 'placement-search-budget');
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'storyDiagnostics');
    else (globalThis as { storyDiagnostics?: unknown }).storyDiagnostics = previous;
  }
});

test('召唤可达落点：preferred 从主人处走得到就原样使用', () => {
  const navigation = new NavigationWorld(openMap());
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const owner = actorAt(200, 200); navigation.register(owner);
  assert.deepEqual(navigation.nearestReachableBody({ collision: body }, { x: 200, y: 200 }, { x: 232, y: 200 }),
    { x: 232, y: 200 });
});

test('召唤可达落点：墙另一侧的 preferred 不可达时留在主人这一侧', () => {
  const walled = openMap();
  for (let row = 0; row < 20; row++) walled.blocked[row * 20 + 10] = true;   // 整列墙，左右不连通
  const navigation = new NavigationWorld(walled);
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const owner = actorAt(140, 160); navigation.register(owner);
  const spot = navigation.nearestReachableBody({ collision: body }, { x: 140, y: 160 }, { x: 184, y: 160 });
  assert.ok(spot);
  assert.notDeepEqual(spot, { x: 184, y: 160 }, '墙另一侧的点不能当召唤落点');
  assert.ok(spot.x < 160, '落点必须留在主人这一侧');
  assert.equal(navigation.canPlaceBody({ collision: body }, spot), true);
  assert.notEqual(navigation.path(owner, spot), null, '落点必须从主人处走得到');
});

test('召唤可达落点：没有 preferred 时就近找可达的整盒点；整图封死或无碰撞盒返回 undefined', () => {
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const navigation = new NavigationWorld(openMap());
  const owner = actorAt(100, 100); navigation.register(owner);
  const spot = navigation.nearestReachableBody({ collision: body }, { x: 100, y: 100 });
  assert.ok(spot);
  assert.notDeepEqual(spot, { x: 100, y: 100 }, '不能和主人重叠');
  assert.equal(navigation.canPlaceBody({ collision: body }, spot), true);
  assert.notEqual(navigation.path(owner, spot), null);

  const sealed = new NavigationWorld({ ...openMap(), blocked: Array(400).fill(true) });
  assert.equal(sealed.nearestReachableBody({ collision: body }, { x: 100, y: 100 }), undefined);
  assert.equal(navigation.nearestReachableBody({}, { x: 100, y: 100 }), undefined, '没有碰撞盒不能落位');
});

test('a party member lands beside the hero with both foot and body free', () => {
  const navigation = new NavigationWorld(openMap());
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const hero = actorAt(100, 100); navigation.register(hero);
  const landing = choosePartyLanding(navigation, { collision: body }, { x: 100, y: 100 });
  assert.ok(landing);
  assert.equal(navigation.terrainFree(landing), true, '脚点必须可站');
  assert.equal(navigation.canPlaceBody({ collision: body }, landing), true, '整盒不能压地形或叠在主角身上');
  assert.ok(Math.hypot(landing.x - 100, landing.y - 100) <= 40, '落点应在主角旁边');
});

test('a party landing keeps clear of the hero and allies after a regroup', () => {
  const navigation = new NavigationWorld(openMap());
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const hero = actorAt(100, 100); navigation.register(hero);
  const first = choosePartyLanding(navigation, { collision: body }, { x: 100, y: 100 });
  assert.ok(first);
  const second = choosePartyLanding(navigation, { collision: body }, { x: 100, y: 100 }, undefined,
    [{ x: 100, y: 100 }, first]);
  assert.ok(second);
  assert.ok(Math.hypot(second.x - 100, second.y - 100) >= 16, '不能叠在主角身上');
  assert.ok(Math.hypot(second.x - first.x, second.y - first.y) >= 16, '不能叠在已有队友身上');
});

test('a party member stays on the hero side of a wall and remains walkable', () => {
  const walled = openMap();
  for (let row = 0; row < 20; row++) walled.blocked[row * 20 + 10] = true;
  const navigation = new NavigationWorld(walled);
  const body = { x: -8, y: -8, width: 16, height: 16 };
  const hero = actorAt(140, 160); navigation.register(hero);
  const landing = choosePartyLanding(navigation, { collision: body }, { x: 140, y: 160 });
  assert.ok(landing);
  assert.ok(landing.x < 160, '落点必须留在主角这一侧');
  assert.notEqual(navigation.path(hero, landing), null, '落点必须从主角处走得到');
});

test('a whole-body candidate with a blocked foot is rejected', () => {
  const map = openMap();
  // 脚点所在格阻挡，但偏移碰撞盒恰好避开这格：整盒口径会放行，落脚判定不能接受。
  map.blocked[6 * 20 + 6] = true;
  const navigation = new NavigationWorld(map);
  const shape = { collision: { x: -24, y: -4, width: 16, height: 16 } };
  const landing = choosePartyLanding(navigation, shape, { x: 100, y: 100 });
  assert.ok(landing);
  assert.notDeepEqual(landing, { x: 100, y: 100 });
  assert.equal(navigation.terrainFree(landing), true, '落点脚点必须可站');
});

test('a sealed map yields no party landing instead of throwing', () => {
  const sealed = new NavigationWorld({ ...openMap(), blocked: Array(400).fill(true) });
  assert.equal(choosePartyLanding(sealed, { collision: { x: -8, y: -8, width: 16, height: 16 } }, { x: 100, y: 100 }), undefined);
});

test('every map settles its whole projected cast with the hero standing anywhere', () => {
  const root = new URL('../public/', import.meta.url);
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
  const world = read('content/world.json'), campaign = read('content/campaign.json');
  let maps = 0, spots = 0;
  for (const reference of world.maps) {
    const map = read(reference.file);
    const authored = campaign.placements.filter((p: { map: string }) => p.map === map.id);
    const placed = map.entities.filter((p: { actor: string }) => !authored.some((a: { actor: string }) => a.actor === p.actor));
    const list = [...placed, ...authored];
    if (!list.length) continue;
    maps++;
    const navigation = new NavigationWorld(map);
    const targets: Placement[] = list.map((e: { actor: string; x: number; y: number }) => {
      const point = { x: e.x, y: e.y };
      const actor: NavigationActor = { shape: () => ({ collision: world.actors[e.actor]?.collision }), position: () => point, enabled: () => true };
      navigation.register(actor); return { actor, position: point, enabled: true };
    });
    // 主角逐个站到本图每个实体上：投影要先让位，再按"只校验移动的"落位。
    for (const spot of list) {
      spots++;
      const heroPoint = { x: spot.x, y: spot.y };
      const hero: NavigationActor = { shape: () => ({ collision: world.actors[campaign.start.actor]?.collision }), position: () => heroPoint, enabled: () => true };
      navigation.register(hero);
      const settled = new Map(targets.map(p => [p.actor, p.position]));
      for (const e of navigation.evictionsFor(targets, new Set([hero]))) settled.set(e.actor, e.position);
      if (!settled.has(hero)) settled.set(hero, heroPoint);
      assert.equal(navigation.canSettleAll([...settled].map(([actor, position]) => ({ actor, position, enabled: true }))), true, `${map.id} @ ${spot.id} 落位失败`);
      const unregister = (navigation as unknown as { unregister?: (actor: NavigationActor) => void }).unregister;
      unregister?.call(navigation, hero);
    }
  }
  assert.ok(maps > 100 && spots > 1000, `覆盖不足：${maps} 张地图 / ${spots} 个站位`);
});

test('every campaign placement still lands when the hero stands exactly on it', () => {
  const root = new URL('../public/content/', import.meta.url);
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
  const world = read('world.json'), campaign = read('campaign.json');
  const body = (id: string, x: number, y: number): NavigationActor => {
    const point = { x, y };
    return { shape: () => ({ collision: world.actors[id]?.collision }), position: () => point, enabled: () => true };
  };
  for (const mapId of [...new Set(campaign.placements.map((p: { map: string }) => p.map))]) {
    const terrain = read(`maps/${mapId}.json`);
    const navigation = new NavigationWorld(terrain);
    const list = campaign.placements.filter((p: { map: string }) => p.map === mapId);
    // 最坏情况：主角站到本图第一个剧情人物的落点上。原版允许 NPC 站在玩家走不进去的格子
    // （自己的摆放记录就在障碍格上），这时主角只能站在它旁边——按邻格取主角位。
    const anchor = list[0];
    const spot = [{ x: anchor.x, y: anchor.y }, ...[[16, 0], [-16, 0], [0, 16], [0, -16]].map(([dx, dy]) => ({ x: anchor.x + dx, y: anchor.y + dy }))]
      .find(point => canStandOnTerrain(terrain, point.x, point.y));
    if (!spot) continue;
    const hero = body(campaign.start.actor, spot.x, spot.y); navigation.register(hero);
    const targets: Placement[] = list.map((p: { actor: string; x: number; y: number }) => {
      const actor = body(p.actor, p.x, p.y); navigation.register(actor); return { actor, position: { x: p.x, y: p.y }, enabled: true };
    });
    const evicted = navigation.evictionsFor(targets, new Set([hero]));
    const settled = new Map<NavigationActor, { x: number; y: number }>(targets.map(p => [p.actor, p.position]));
    for (const e of evicted) settled.set(e.actor, e.position);
    if (!settled.has(hero)) settled.set(hero, evicted.find(e => e.actor === hero)?.position ?? spot);
    // 与生产一致：地图自带的那批人物保持原位时允许贴在障碍格或与邻格重叠（`canSettleAll`），
    // 只有位置真的被挪动过的那些才按 `canPlaceAll` 的口径校验。
    assert.equal(navigation.canSettleAll([...settled].map(([actor, position]) => ({ actor, position, enabled: true }))), true, `${mapId} 落位失败`);
    for (const t of targets) assert.deepEqual(settled.get(t.actor), t.position, `${mapId} 的剧情人物被挪动`);
  }
});
