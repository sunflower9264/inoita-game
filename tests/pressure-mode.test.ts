import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { pressureEnemy } from '../src/domain/pressure-enemies.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
const { WorldScene } = await import('../src/scenes/world-scene.ts');
hook.deregister();

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;

function combatHost(overrides: Record<string, unknown> = {}) {
  return Object.setPrototypeOf({
    closed: false, defeated: false, movement: {}, arena: [], pendingDefeats: new PendingEnemyDefeats(),
    app: { battleCatalog: battle, session: { party: { activeIds: [] } } },
    ...overrides
  }, WorldCombat.prototype) as {
    closed: boolean; defeated: boolean; arena: unknown[]; app: unknown;
    spawnPressureEnemy(enemyId?: string): boolean;
    reviveFallenForPressure(): void;
  };
}

test('压测刷怪达到上限后不再生成', () => {
  const host = combatHost({ arena: Array.from({ length: 40 }, (_, index) => ({ key: `enemy-${index}` })) });
  assert.equal(host.spawnPressureEnemy(), false);
});

test('压测阵亡只补满倒下的成员，全灭入口不进入阵亡状态', () => {
  const revived: string[] = [];
  const host = combatHost({
    app: { pressureMode: true, battleCatalog: battle, session: { party: { activeIds: ['player', 'ally'] } } },
    memberOf: (id: string) => ({ player: { health: id === 'player' ? 0 : 100 } }),
    scene: { reviveMember: (id: string) => { revived.push(id); return { ok: true }; } }
  });
  host.reviveFallenForPressure();
  assert.deepEqual(revived, ['player']);

  const playerDefeated = Reflect.get(WorldCombat.prototype, 'playerDefeated') as (this: unknown) => void;
  playerDefeated.call(host);
  assert.equal(host.defeated, false, '压测全灭不进入 defeated');
  assert.deepEqual(revived, ['player', 'player'], '全灭入口会再次尝试补满倒下成员');
});

test('压测模式拒绝手动存档和检查点', () => {
  const host = Object.setPrototypeOf({ app: { pressureMode: true }, session: {} }, WorldScene.prototype) as {
    app: { pressureMode: boolean };
  };
  const captureSaveWorld = WorldScene.prototype.captureSaveWorld as (this: unknown) => unknown;
  assert.deepEqual(captureSaveWorld.call(host), { ok: false, reason: 'pressure' });
  const captureCheckpoint = Reflect.get(WorldScene.prototype, 'captureCheckpoint') as (this: unknown) => boolean;
  assert.equal(captureCheckpoint.call(host), false);
});


test('挑战怪物按角色等级随机选择普通战斗怪', () => {
  const first = pressureEnemy(battle.enemies, 1, () => 0)!;
  const last = pressureEnemy(battle.enemies, 1, () => 0.999999)!;
  assert.notEqual(first.id, last.id);
  assert.ok(first.level !== null && first.level <= 3);
  assert.ok(last.level !== null && last.level <= 3);
  assert.equal(first.specialRank, 0);
  const higher = pressureEnemy(battle.enemies, 44, () => 0)!;
  assert.ok(higher.level !== null && Math.abs(higher.level - 44) <= 2);
  assert.equal(pressureEnemy([], 1), undefined);
});

test('挑战模式先按出生点刷怪，补怪达到上限时不加载素材', async () => {
  const created: {id:string;point?:{x:number;y:number}}[]=[];
  let callback=()=>{};
  let allowed=true;
  const host=Object.setPrototypeOf({
    app:{pressureMode:true,battleCatalog:battle,session:{hero:{level:1}}},
    request:new AbortController(),destroyed:false,pressureStartPoints:[{x:10,y:20},{x:30,y:40}],
    combat:{canSpawnPressureEnemy:()=>allowed,preparePressureEnemy:async()=>true,
      spawnPressureEnemy:(id:string,point?:{x:number;y:number})=>created.push({id,point})},
    time:{addEvent:(options:{callback:()=>void})=>{callback=options.callback;return {};}}
  },WorldScene.prototype) as InstanceType<typeof WorldScene>;
  await host.startPressureSpawner();
  assert.deepEqual(created.map(entry=>entry.point),[{x:10,y:20},{x:30,y:40}]);
  allowed=false;callback();
  assert.equal(created.length,2);
  allowed=true;callback();await Promise.resolve();
  assert.equal(created.length,3);
});
