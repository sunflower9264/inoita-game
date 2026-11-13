import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { StoryUIContext } from '../src/application/ports.ts';
import type { Session } from '../src/domain/session.ts';
import type { WorldIndex } from '../src/domain/content.ts';
import type { SavePageHost } from '../src/ui/save-page.ts';

// 存档页依赖 UiSurface 的类型与绘制边界；这里只短路 Phaser 运行时。
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {
      WEBGL: 2, BlendModes: { NORMAL: 0, ADD: 1 },
      Scene: class {}, Geom: { Rectangle: class {}, Circle: class {} },
      Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) }
    };
  `)}` } : next(specifier, context);
} });
const { SavePage } = await import('../src/ui/save-page.ts');
hook.deregister();

function fixture() {
  let renders = 0, confirmations = 0, syncs = 0, busy = false, notice = '';
  const written: string[] = [];
  const app = {
    saves: {
      peek: () => ({ kind: 'empty' as const }),
      write: (slot: number) => written.push(`write:${slot}`),
      erase: (slot: number) => written.push(`erase:${slot}`),
      rename: (slot: number, name: string) => written.push(`rename:${slot}:${name}`)
    },
    saveSlot: undefined as number | undefined,
    storyClasses: { classes: [{ id: 'dark-knight', name: '暗骑士' }] },
    menuPanels: { character: { portraits: { kiyan: { image: 'kiyan.png' } } }, assets: {} },
    captureSaveWorld: () => ({ ok: true as const, map: { id: 'map', name: '地图' }, world: { location: {} } }),
    audio: { ui() {} }
  } as unknown as StoryUIContext;
  const session = {
    character: { classId: 'dark-knight' }, player: { level: 5 },
    campaign: { start: { actor: 'kiyan' } },
    capturePersistentState: () => ({})
  } as unknown as Session;
  const world = { actors: { kiyan: { portrait: 'kiyan' } } } as unknown as WorldIndex;
  const host: SavePageHost = {
    app,
    session: () => session,
    world: () => world,
    contentAssets: () => ({ 'save-slot': 'slot.png', 'save-empty': 'empty.png' }),
    updateConfirmation:()=>{confirmations += 1;},
    render: () => { renders += 1; },
    sync: () => { syncs += 1; },
    busy: () => busy,
    setBusy: value => { busy = value; },
    activeRequest: () => new AbortController(),
    setItemNotice: message => { notice = message; },
    modal: () => { throw new Error('测试不画弹层'); },
    modalWriter: () => ({ add: () => {} }),
    beginModal: () => {},
    scroll: () => { throw new Error('测试不画滚动区'); },
    finishScroll: () => {}
  };
  return { page: new SavePage(host), session, app, written,
    renders: () => renders, confirmations:()=>confirmations, syncs: () => syncs, notice: () => notice };
}

interface SavePageInternals {
  saveConfirm?: number;
  loadConfirm?: number;
  deleteConfirm?: number;
  renameRef?: number;
  saving: boolean;
  requestLoad(ref: number): void;
  requestDelete(ref: number): void;
}

test('存档页的 Escape 只关最上层确认，并逐层退回', () => {
  const f = fixture();
  const internals = f.page as unknown as SavePageInternals;
  internals.deleteConfirm = 2;
  internals.loadConfirm = 1;
  internals.saveConfirm = 3;
  assert.equal(f.page.modalOpen, true);
  const event = { key: 'Escape', preventDefault() {} } as KeyboardEvent;

  assert.equal(f.page.handleEscape(event), true);
  assert.equal(internals.deleteConfirm, undefined);
  assert.equal(internals.loadConfirm, 1, '删除确认关掉后读档确认还在');
  assert.equal(f.confirmations(), 1);

  assert.equal(f.page.handleEscape(event), true);
  assert.equal(internals.loadConfirm, undefined);
  assert.equal(internals.saveConfirm, 3, '读档确认关掉后覆盖确认还在');
  assert.equal(f.confirmations(), 2);

  assert.equal(f.page.handleEscape(event), true);
  assert.equal(internals.saveConfirm, undefined);
  assert.equal(f.confirmations(), 3);

  assert.equal(f.page.handleEscape(event), false, '没有确认时把 Escape 还给菜单');
  assert.equal(f.confirmations(), 3);
});

test('改名输入和确认框共同决定页面是否让出输入', () => {
  const f = fixture();
  const internals = f.page as unknown as SavePageInternals;
  assert.equal(f.page.blocksPage, false);
  internals.renameRef = 1;
  assert.equal(f.page.renaming, true);
  assert.equal(f.page.blocksPage, true);
  assert.equal(f.page.modalOpen, false, '改名输入不是弹层');

  f.page.closeInput();
  assert.equal(f.page.renaming, false);
  assert.equal(f.page.blocksPage, false);

  internals.saveConfirm = 2;
  assert.equal(f.page.blocksPage, true);
  assert.equal(f.page.modalOpen, true);
  f.page.cancelPending();
  assert.equal(f.page.blocksPage, false);
  assert.equal(f.page.modalOpen, false);
});

test('保存截图等待期间存档页不接受删除或读取确认', () => {
  const f = fixture();
  const internals = f.page as unknown as SavePageInternals;
  (f.app.saves as unknown as { peek: () => { kind: string } }).peek = () => ({ kind: 'ok' });
  internals.requestDelete(1);
  assert.equal(internals.deleteConfirm, 1, '普通状态下可以打开删除确认');
  f.page.cancelPending();

  internals.saving = true;
  assert.equal(f.page.blocksPage, true, '保存等待期间页面让出输入');
  internals.requestDelete(1);
  internals.requestLoad(1);
  assert.equal(internals.deleteConfirm, undefined, '保存等待期间不打开删除确认');
  assert.equal(internals.loadConfirm, undefined, '保存等待期间不打开读取确认');

  internals.saving = false;
  assert.equal(f.page.blocksPage, false);
});

test('存档快照与摘要仍由同一入口生成', () => {
  const f = fixture();
  const captured = f.page.captureSaveRecord();
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.record.summary.className, '暗骑士');
  assert.equal(captured.record.summary.portrait, 'kiyan.png');
  assert.equal(captured.record.summary.mapName, '地图');
  assert.equal(captured.record.summary.level, 5);
  assert.deepEqual(captured.record.world, { location: {} });
});
