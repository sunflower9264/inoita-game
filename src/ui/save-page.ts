import {
  AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, captureSaveGame, saveSlotLabel, saveSummary, sessionClassId,
  type SaveGame, type SaveSlotRef
} from '../domain/save-game.ts';
import type { Session } from '../domain/session.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { SaveWorldReason, StoryWorldViewSnapshot } from '../scenes/world-scene.ts';
import { SAVE_BOARD, SAVE_BOARD_LAYOUT, drawSaveBoardRow, newestFirstSlots, saveBoardOrigin, saveRowTitle, type SaveBoardRow } from './phaser/save-board.ts';
import { drawNativeMessage, type NativeMessageBand } from './phaser/native-message.ts';
import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH } from './phaser/modal-placement.ts';
import type { ScrollArea, UiSurface } from './phaser/widgets.ts';
import type { MenuTextWriter } from './dom/menu-text.ts';
import { TextPrompt } from './text-prompt.ts';

/** 存档结果与「不能存取」的提示文本，原版取文本表 35331／35332／35342 条。 */
const SAVE_DONE = '保存成功', SAVE_FAILED = '保存失败', SAVE_UNAVAILABLE = '在当前的地图中无法进行存档。';
const SAVE_UNAVAILABLE_DEBUG = '调试现场不能存档，请先在调试面板点「结束本次调试」。';
const SAVE_UNAVAILABLE_PRESSURE = '压测模式不能存档。';
const SAVE_UNAVAILABLE_LOADING = '地图正在载入，请稍后再存档。';
const SAVE_UNAVAILABLE_NO_SURVIVORS = '队伍已经全员阵亡，无法存档。';
const saveUnavailableNotice = (reason: SaveWorldReason): string => reason === 'debug' ? SAVE_UNAVAILABLE_DEBUG
  : reason === 'pressure' ? SAVE_UNAVAILABLE_PRESSURE
  : reason === 'loading' ? SAVE_UNAVAILABLE_LOADING
  : reason === 'no-survivors' ? SAVE_UNAVAILABLE_NO_SURVIVORS : SAVE_UNAVAILABLE;

/**
 * 存档/读档页宿主要提供的能力。控制器只负责这一页的状态和操作，
 * 整页重绘、忙碌标记、弹层定位和滚动区位置仍由菜单统一管理。
 */
export interface SavePageHost {
  readonly app: StoryUIContext;
  session(): Session | undefined;
  world(): WorldIndex | undefined;
  /** 当前剧情界面的素材表，和菜单页共用同一份存档槽图。 */
  contentAssets(): Record<string, string>;
  render(): void;
  updateConfirmation(): void;
  sync(): void;
  busy(): boolean;
  setBusy(value: boolean): void;
  activeRequest(): AbortController;
  setItemNotice(message: string): void;
  modal(): UiSurface;
  /** 弹层文字的 DOM 出口；确认框正文与按钮文字都从这里登记。 */
  modalWriter(): MenuTextWriter;
  beginModal(width: number, height: number): void;
  scroll(name: string, x: number, y: number, width: number, height: number, surface: UiSurface): ScrollArea;
  finishScroll(name: string, scroll: ScrollArea, height: number): void;
}

/**
 * 存档槽页：自动槽固定一行，十个手动槽按写入时间倒序。
 * 页面自己的确认框、改名输入和读档请求都在这里；菜单只负责路由和整页重绘。
 */
export class SavePage {
  /** 一次只处理一个保存请求：截图要等下一帧，期间重复点击不能写两次。 */
  private saving = false;
  /** 保存请求代次；关页、切页或新请求让迟到的截图结果失效。 */
  private saveSerial = 0;
  private saveConfirm?: SaveSlotRef;
  private loadConfirm?: SaveSlotRef;
  private deleteConfirm?: SaveSlotRef;
  private renameRef?: SaveSlotRef;
  private renameSerial=0;
  private messageBand?: NativeMessageBand;
  private readonly prompt = new TextPrompt();
  private readonly host: SavePageHost;

  constructor(host: SavePageHost) { this.host = host; }

  /** 页面自身有确认框或改名输入时，底层按钮不再接收输入。 */
  get blocksPage(): boolean {
    return this.saveConfirm !== undefined || this.loadConfirm !== undefined
      || this.deleteConfirm !== undefined || this.renameRef !== undefined;
  }

  /** 确认框会盖在页面之上，走菜单公共弹层。 */
  get modalOpen(): boolean {
    return this.saveConfirm !== undefined || this.loadConfirm !== undefined || this.deleteConfirm !== undefined;
  }

  /** 确认横带的弹层本地上下边界；菜单用它裁剪底层页面文字。 */
  get band(): NativeMessageBand | undefined {
    return this.messageBand;
  }

  get renaming(): boolean {
    return this.renameRef !== undefined;
  }

  render(view: UiSurface, loading: boolean): void {
    const app = this.host.app;
    view.text(loading ? '读取存档' : '存档槽', 512, 16, 0, 28).setOrigin(.5, 0);
    const content = this.host.contentAssets();
    const assets = { frame: content['save-slot'], empty: content['save-empty'] };
    const origin = saveBoardOrigin(view.width);
    // 自动存档固定一行置顶：读档页可读，存档页只展示；永远没有改名与删除。
    drawSaveBoardRow(view, assets, origin, SAVE_BOARD_LAYOUT.autoTop, this.saveRow(AUTO_SAVE_SLOT, loading));
    // 十个手动槽放进滚动区；按写入时间倒序，最新的排最前，空槽排在后面。
    const scroll = this.host.scroll('slots', origin.x, SAVE_BOARD_LAYOUT.listTop, SAVE_BOARD.panelWidth, SAVE_BOARD_LAYOUT.listHeight, view);
    newestFirstSlots(slot => app.saves.peek(slot)).forEach((slot, index) =>
      drawSaveBoardRow(view, assets, { x: 0, y: 0 }, index * SAVE_BOARD.rowStep, this.saveRow(slot, loading), scroll.content));
    this.host.finishScroll('slots', scroll, (MANUAL_SAVE_SLOT_COUNT - 1) * SAVE_BOARD.rowStep + SAVE_BOARD.frameHeight);
  }

  /** 确认框由菜单的公共弹层画；三个确认只按用户打开的顺序存在一个。 */
  renderConfirmations(): void {
    const app = this.host.app;
    this.messageBand = undefined;
    if (this.loadConfirm !== undefined) {
      const slot = this.loadConfirm;
      this.host.beginModal(MENU_CANVAS_WIDTH, MENU_CANVAS_HEIGHT);
      this.messageBand = drawNativeMessage(this.host.modal(), app.menuPanels.assets, '读取存档将丢失当前未保存的进度，确定读取？',
        () => { this.loadConfirm = undefined; void this.loadFromSlot(slot); },
        () => { this.loadConfirm = undefined; this.host.updateConfirmation(); }, this.host.modalWriter(), this.messageScroll());
    }
    if (this.saveConfirm !== undefined) {
      const slot = this.saveConfirm;
      this.host.beginModal(MENU_CANVAS_WIDTH, MENU_CANVAS_HEIGHT);
      this.messageBand = drawNativeMessage(this.host.modal(), app.menuPanels.assets, '这个存档槽里已经有存档，确定覆盖？',
        () => { this.saveConfirm = undefined; void this.saveToSlot(slot); },
        () => { this.saveConfirm = undefined; this.host.updateConfirmation(); }, this.host.modalWriter(), this.messageScroll());
    }
    if (this.deleteConfirm !== undefined) {
      const slot = this.deleteConfirm;
      this.host.beginModal(MENU_CANVAS_WIDTH, MENU_CANVAS_HEIGHT);
      this.messageBand = drawNativeMessage(this.host.modal(), app.menuPanels.assets, '删除后无法恢复，确定删除这个存档？',
        () => this.deleteSlot(slot),
        () => { this.deleteConfirm = undefined; this.host.updateConfirmation(); }, this.host.modalWriter(), this.messageScroll());
    }
  }

  /** 确认框正文过长时在弹层里滚动；滚动区仍走菜单统一登记入口。 */
  private messageScroll(): { scroll(name: string, x: number, y: number, width: number, height: number): ScrollArea } {
    return { scroll: (name, x, y, width, height) => this.host.scroll(name, x, y, width, height, this.host.modal()) };
  }

  /** Escape 只关最上层的存档确认；返回 true 表示这次按键已处理。 */
  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape') return false;
    if (this.deleteConfirm !== undefined) {
      event.preventDefault(); this.deleteConfirm = undefined; this.host.updateConfirmation(); return true;
    }
    if (this.loadConfirm !== undefined) {
      event.preventDefault(); this.loadConfirm = undefined; this.host.updateConfirmation(); return true;
    }
    if (this.saveConfirm !== undefined) {
      event.preventDefault(); this.saveConfirm = undefined; this.host.updateConfirmation(); return true;
    }
    return false;
  }

  /** 切换页面或关闭菜单时清掉确认框和改名输入，并让在途保存结果失效。 */
  cancelPending(): void {
    this.saveSerial++;this.renameSerial++;
    this.saving = false;
    this.saveConfirm = undefined;
    this.loadConfirm = undefined;
    this.deleteConfirm = undefined;
    this.renameRef = undefined;
    this.prompt.close();
  }

  /** 页面挂起时只收起系统输入框，保留当前页码。 */
  closeInput(): void {
    if (this.renameRef === undefined) return;
    this.renameSerial++;this.prompt.close();
    this.renameRef = undefined;
  }

  destroy(): void {
    this.cancelPending();
  }

  /** 摘要与快照的唯一捕获口：手动保存与自动存档共用。 */
  captureSaveRecord(screenshot?: string): { ok: true; record: SaveGame<StoryWorldViewSnapshot> } | { ok: false; reason: SaveWorldReason } {
    const session = this.host.session();
    if (!session) return { ok: false, reason: 'not-ready' };
    const capture = this.host.app.captureSaveWorld?.();
    if (!capture || !capture.ok) return { ok: false, reason: capture?.reason ?? 'not-ready' };
    return { ok: true, record: captureSaveGame(session, capture.world, this.saveSummaryOf(session, capture.map, screenshot)) };
  }

  /** 一行存档的读数、动作与行内控件；自动槽在存档页没有动作。 */
  private saveRow(ref: SaveSlotRef, loading: boolean): SaveBoardRow {
    const app = this.host.app;
    const reading = app.saves.peek(ref), title = saveRowTitle(ref, reading), auto = ref === AUTO_SAVE_SLOT;
    const action = loading
      ? reading.kind === 'ok' && app.resumeSlot ? () => this.requestLoad(ref) : undefined
      : auto ? undefined : () => this.requestSave(ref);
    // 行内控件用固定的槽位名（改名后仍叫「存档槽 N 删除」），行本身的标题才用自定义名字。
    const slotLabel = saveSlotLabel(ref);
    const controls = !auto && reading.kind === 'ok' ? [
      { text: '改名', label: `${slotLabel} 改名`, action: () => this.renameSlot(ref) },
      { text: '删除', label: `${slotLabel} 删除`, action: () => this.requestDelete(ref) },
    ] : !auto && reading.kind === 'unreadable' ? [
      { text: '删除', label: `${slotLabel} 删除`, action: () => this.requestDelete(ref) },
    ] : undefined;
    return { reading, action, label: title, title, auto, ...(controls ? { controls } : {}) };
  }

  private requestLoad(ref: SaveSlotRef): void {
    if (this.host.busy() || this.host.app.saves.peek(ref).kind !== 'ok') return;
    this.loadConfirm = ref; this.host.updateConfirmation();
  }

  private async loadFromSlot(ref: SaveSlotRef): Promise<void> {
    const load = this.host.app.resumeSlot;
    if (!load || this.host.busy()) return;
    const request = this.host.activeRequest(), session = this.host.session();
    this.host.setBusy(true); this.host.render(); this.host.sync();
    const stillCurrent = () => !request.signal.aborted && this.host.activeRequest() === request && this.host.session() === session;
    try { await load(ref, request.signal); }
    catch (error) { if (stillCurrent()) this.host.setItemNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (stillCurrent()) { this.host.setBusy(false); this.host.render(); this.host.sync(); } }
  }

  /** 点一个手动槽：空槽直接存，已有存档先问一次再覆盖（原版对不可逆操作用是／否确认）。 */
  private requestSave(ref: SaveSlotRef): void {
    if (ref === AUTO_SAVE_SLOT || this.saving) return;
    if (this.host.app.saves.peek(ref).kind === 'empty') { void this.saveToSlot(ref); return; }
    this.saveConfirm = ref; this.host.updateConfirmation();
  }

  private saveToSlot(ref: SaveSlotRef): void {
    if (ref === AUTO_SAVE_SLOT || this.saving) return;
    const captured = this.captureSaveRecord();
    if (!captured.ok) { this.host.setItemNotice(saveUnavailableNotice(captured.reason)); this.host.render(); return; }
    // 没有截图能力时保持同步写档；有截图能力时等下一帧截完再写，失败仍写无图存档。
    if (!this.host.app.captureSaveThumbnail) { this.writeSlot(ref, captured.record); return; }
    this.saving = true;
    const serial = ++this.saveSerial;
    const screenshot = this.host.app.captureSaveThumbnail();
    void screenshot.then(url => {
      if (url) captured.record.summary.screenshot = url;
    }).catch(() => undefined).finally(() => {
      // 关页、切页或发起了新的保存时，迟到的截图结果不能再写旧槽。
      if (serial !== this.saveSerial) return;
      this.saving = false;
      this.writeSlot(ref, captured.record);
    });
  }

  private writeSlot(ref: number, record: SaveGame<StoryWorldViewSnapshot>): void {
    try {
      this.host.app.saves.write(ref, record);
      this.host.app.saveSlot = ref;
      this.host.app.audio?.ui('select');
      this.host.setItemNotice(SAVE_DONE);
    } catch (error) {
      console.warn('存档写入失败', error); this.host.setItemNotice(SAVE_FAILED);
    }
    this.host.render();
  }

  /** 删除手动存档；删掉的正是当前槽时清空 `saveSlot`。 */
  private requestDelete(ref: SaveSlotRef): void {
    if (ref === AUTO_SAVE_SLOT) return;
    if (this.host.app.saves.peek(ref).kind === 'empty') return;
    this.deleteConfirm = ref; this.host.updateConfirmation();
  }

  private deleteSlot(ref: SaveSlotRef): void {
    try {
      this.host.app.saves.erase(ref);
      if (this.host.app.saveSlot === ref) this.host.app.saveSlot = undefined;
      this.host.app.audio?.ui('select');
    } catch (error) {
      console.warn('删除存档失败', error); this.host.setItemNotice(SAVE_FAILED);
    }
    this.deleteConfirm = undefined; this.host.render();
  }

  /** 改名：手机系统键盘输入，只收中文、英文、数字；确认后只改摘要里的名字。 */
  private renameSlot(ref: SaveSlotRef): void {
    if (ref === AUTO_SAVE_SLOT) return;
    const reading = this.host.app.saves.peek(ref);
    if (reading.kind !== 'ok') return;
    const serial=++this.renameSerial;this.renameRef=ref;
    const apply = (value: string | undefined): void => {
      if(serial!==this.renameSerial||this.renameRef!==ref)return;
      if (value !== undefined) {
        try { this.host.app.saves.rename(ref, value); }
        catch (error) { console.warn('存档改名失败', error); }
      }
      this.renameRef = undefined;if(value!==undefined)this.host.render();this.host.sync();
    };
    // 测试没有 DOM 输入框，直接注入一个返回值。
    if (this.host.app.promptText) {
      this.host.sync();void this.host.app.promptText(reading.summary.name ?? '').then(apply,()=>apply(undefined));return;
    }
    this.host.sync();
    this.prompt.show({ title: '存档名称', initial: reading.summary.name ?? '',
      onConfirm: value => apply(value), onCancel: () => apply(undefined) });
    // 没有 DOM（测试或极端环境）时输入框起不来，别让菜单一直处于「让出输入」状态。
    if (!this.prompt.active) { this.renameRef = undefined; this.host.sync(); }
  }

  /** 摘要里的职业名和缩略图在存档时就展开，标题页读档不必再加载职业目录。 */
  private saveSummaryOf(session: Session, map: { id: string; name: string }, screenshot?: string) {
    const app = this.host.app;
    const classId = sessionClassId(session) ?? '';
    return saveSummary(session, map, { name: app.storyClasses.classes.find(value => value.id === classId)?.name ?? classId, portrait: this.playerPortrait().image }, screenshot);
  }

  /** 主角的立绘：存档槽里画的是他，与菜单当前选中的队员无关。 */
  private playerPortrait() {
    const session = this.host.session()!;
    const actor = this.host.world()!.actors[session.campaign.start.actor];
    const portraits = this.host.app.menuPanels.character.portraits;
    return portraits[actor.portrait ?? 'kiyan'] ?? portraits.kiyan;
  }
}
