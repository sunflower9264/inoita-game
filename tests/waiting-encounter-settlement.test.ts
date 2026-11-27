import assert from 'node:assert/strict';
import test from 'node:test';
import { captureSaveGame, restoreSaveGame, saveSummary } from '../src/domain/save-game.ts';
import { playthrough } from './helpers/story-playthrough.ts';

test('被 30% 锁血或击败剧情接管的挂起战斗在完成时与旧档恢复时自动结清，不再跨章节锁死检查点', async () => {
  const h = playthrough();
  const { session, director } = h;
  try {
    // 1. 实时流程：古神殿 event-54 进入 waitEncounter（鑫迪），随后 event-55（鑫迪 30% 血切图）完成时自动结清 event-54
    session.accept('quest-41');
    session.applyStoryCommands([
      { type: 'travel', destination: { map: 'old-sanctuary-54cffd62', x: 200, y: 200, facing: 'north' } },
    ]);
    await director.enterRegion('event-54', 'old-sanctuary-54cffd62');
    await h.idle();
    assert.equal(session.hasWaitingStoryRun, true);
    assert.equal(session.hasWaitingEncounterOnMap('old-sanctuary-54cffd62'), true);
    assert.equal(session.hasWaitingEncounterOnMap('border-gateway-67e044a2'), false, '非遭遇所在地图不阻塞检查点');

    await director.notify('battle', 'health-below-30:enemy-shin-1', 'old-sanctuary-54cffd62');
    await h.idle();
    assert.equal(session.hasWaitingStoryRun, false, 'event-55 完成后自动结清 event-54 的挂起战斗');
    assert.ok(session.runtimeState.completedEvents.includes('event-54'));
    assert.equal(session.storyWorld.activeEncounters.length, 0);

    // 2. 历史存档恢复：模拟线上 gm:1795788466651 中同时残留 event-54、event-40 与双阶段首领链的存档，读档即自动排空
    const legacy = playthrough();
    try {
      const snapshot = legacy.session.captureState();
      snapshot.enemies.push([
        'story:51:done:event-40-battle:enemy-0',
        { deadUntil: 'permanent' },
      ]);
      snapshot.storyWorld.encounters.push(
        {
          id: 'story:33:done:event-54-battle',
          definitionId: 'event-54-battle',
          map: 'old-sanctuary-54cffd62',
          status: 'active',
          spawns: [{ id: 'enemy-0', enemyId: 'enemy-shin-1', x: 280, y: 216 }],
        },
        {
          id: 'story:51:done:event-40-battle',
          definitionId: 'event-40-battle',
          map: 'goblin-s-lair-3-c6e77244',
          status: 'active',
          spawns: [{ id: 'enemy-0', enemyId: 'enemy-head-goblin-yirzuch-1', x: 216, y: 280 }],
        },
        {
          id: 'story:70:done:event-359-battle',
          definitionId: 'event-359-battle',
          map: 'room-of-resurrection-394abb48',
          status: 'active',
          spawns: [{ id: 'enemy-0', enemyId: 'enemy-alexander-1', x: 264, y: 136 }],
        },
        {
          id: 'story:71:done:event-360-battle',
          definitionId: 'event-360-battle',
          map: 'room-of-resurrection-394abb48',
          status: 'active',
          spawns: [{ id: 'enemy-0', enemyId: 'enemy-dragon-alexander-1', x: 264, y: 152 }],
        },
      );
      snapshot.runtime = {
        ...snapshot.runtime,
        sequence: 80,
        completedEvents: ['event-42', 'event-55', 'event-361'],
        runs: [
          {
            id: 'story:33',
            script: 'event-54',
            eventId: 'event-54',
            occurrence: 'region:event-54:1',
            cursor: { script: 'event-54', node: 'done' },
            status: 'waiting',
            waiting: {
              encounter: 'story:33:done:event-54-battle',
              outcomes: {
                won: { script: 'event-54', node: 'battle-won' },
                lost: { script: 'event-54', node: 'battle-lost' },
              },
            },
          },
          {
            id: 'story:51',
            script: 'event-40',
            eventId: 'event-40',
            occurrence: 'region:event-40:2',
            cursor: { script: 'event-40', node: 'done' },
            status: 'waiting',
            waiting: {
              encounter: 'story:51:done:event-40-battle',
              outcomes: {
                won: { script: 'event-40', node: 'battle-won' },
                lost: { script: 'event-40', node: 'battle-lost' },
              },
            },
          },
          {
            id: 'story:70',
            script: 'event-359',
            eventId: 'event-359',
            occurrence: 'region:event-359:3',
            cursor: { script: 'event-359', node: 'done' },
            status: 'waiting',
            waiting: {
              encounter: 'story:70:done:event-359-battle',
              outcomes: {
                won: { script: 'event-359', node: 'battle-won' },
                lost: { script: 'event-359', node: 'battle-lost' },
              },
            },
          },
          {
            id: 'story:71',
            script: 'event-360',
            eventId: 'event-360',
            occurrence: 'battle:event-360:4',
            cursor: { script: 'event-360', node: 'done' },
            status: 'waiting',
            waiting: {
              encounter: 'story:71:done:event-360-battle',
              outcomes: {
                won: { script: 'event-360', node: 'battle-won' },
                lost: { script: 'event-360', node: 'battle-lost' },
              },
            },
          },
        ],
      };

      const diagnostics: { type: string; detail?: unknown }[] = [];
      const prevDiag = globalThis.storyDiagnostics;
      globalThis.storyDiagnostics = {
        record(type: string, detail?: unknown) {
          diagnostics.push({ type, detail });
        },
      } as never;
      try {
        // 内部沙盒/检查点调用 Session.restoreState 时不触发存档修补诊断
        const sandbox = legacy.session.createStorySandbox();
        sandbox.restoreState(snapshot);
        assert.equal(sandbox.hasWaitingStoryRun, true, '内部 restoreState 保持原样，不误报修补');
        assert.equal(diagnostics.length, 0);

        // 正式读档入口 restoreSaveGame 一次性不动点结清全部单阶段与双阶段残留 waiting 运行
        const saved = captureSaveGame(
          sandbox,
          { map: 'border-gateway-67e044a2' },
          saveSummary(sandbox, { id: 'border-gateway-67e044a2', name: '边境关口' }, { name: '黑魔导', portrait: 'p.png' }),
        );
        restoreSaveGame(legacy.session, saved);
        assert.equal(legacy.session.hasWaitingStoryRun, false, '读档时幂等结清已由后续战斗剧情收尾的残留 waiting 运行');
        assert.equal(legacy.session.storyWorld.activeEncounters.length, 0);
        for (const id of ['event-40', 'event-54', 'event-359', 'event-360']) {
          assert.ok(legacy.session.runtimeState.completedEvents.includes(id), `应补齐完成事件 ${id}`);
        }
        assert.equal(diagnostics.filter(entry => entry.type === 'save-repaired-waiting-encounters').length, 1);
      } finally {
        globalThis.storyDiagnostics = prevDiag;
      }
    } finally {
      legacy.director.dispose();
    }
  } finally {
    director.dispose();
  }
});
