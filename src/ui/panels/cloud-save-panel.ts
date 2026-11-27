import type { MenuTextSpec } from '../dom/menu-text.ts';
import type { UiNode } from '../dom/node.ts';
import { TEXT_COLORS } from '../text-style.ts';
import {
  CLOUD_PAGE,
  cloudStatusColor,
  cloudStatusKind,
  cloudStatusText,
  type CloudPageActions,
  type CloudPageState,
} from '../cloud-save-layout.ts';
import { GOLD, type ScrollArea, type UiSurface } from '../widgets.ts';

interface CloudSavePageAssets {
  frame: string;
  close: string;
  closePressed: string;
}

export interface CloudSaveDomOutput {
  texts: MenuTextSpec[];
  controls: UiNode[];
  scroll?: ScrollArea;
}

interface CloudTextSink {
  add(spec: MenuTextSpec): void;
}

function drawStatus(
  view: UiSurface,
  state: CloudPageState,
  left: number,
  y: number,
  width: number,
  parent: UiNode,
  scroll: ScrollArea,
  sink?: CloudTextSink,
): void {
  const text = cloudStatusText(state) ?? (!state.available ? '云存档暂不可用，本机存档不受影响。' : '');
  const color = !state.available && !cloudStatusText(state) ? TEXT_COLORS.dangerSoft : cloudStatusColor(cloudStatusKind(state));
  if (sink) {
    sink.add({
      key: 'cloud-status',
      text,
      x: scroll.x + left,
      y: scroll.y + y,
      style: { size: 22, color, width, wrap: 'word' },
      scroll: 'cloud-note',
      clip: { top: scroll.y, bottom: scroll.y + scroll.height },
    });
    return;
  }
  view.text(text, left, y, width, 22, color, parent);
}

/**
 * 云存档页：账号/密码输入、登录注册，或已登录后的导入/下载/退出。
 * 传入 `domMode` 时显式收集 DOM 文字规格与控件句柄，无需宿主篡改 `view.text`/`view.button`。
 */
export function drawCloudSavePage(
  view: UiSurface,
  state: CloudPageState,
  actions: CloudPageActions,
  assets: CloudSavePageAssets,
  domMode = false,
): CloudSaveDomOutput {
  const texts: MenuTextSpec[] = [];
  const controls: UiNode[] = [];
  let serial = 0;
  const sink: CloudTextSink | undefined = domMode ? { add: spec => texts.push(spec) } : undefined;
  const emitPageText = (
    key: string,
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    color = GOLD,
    anchorX = 0,
    anchorY = 0,
  ): void => {
    if (sink) {
      sink.add({
        key,
        text: value,
        x,
        y,
        style: {
          size,
          color,
          anchorX,
          anchorY,
          align: anchorX === 0.5 ? 'center' : undefined,
          width: width || undefined,
          wrap: width ? 'word' : undefined,
        },
      });
      return;
    }
    const label = view.text(value, x, y, width, size, color);
    if (anchorX || anchorY) label.setOrigin(anchorX, anchorY);
  };
  const emitNoteText = (
    note: ScrollArea,
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    color: string,
  ): void => {
    if (sink) {
      sink.add({
        key: `cloud-${serial++}`,
        text: value,
        x: note.x + x,
        y: note.y + y,
        style: { size, color, width, wrap: 'word' },
        scroll: 'cloud-note',
        clip: { top: note.y, bottom: note.y + note.height },
      });
      return;
    }
    view.text(value, x, y, width, size, color, note.content);
  };
  const emitButton = (
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    action: () => void,
    options: { image?: string; pressed?: string; fontSize?: number; disabled?: boolean; accessibleLabel?: string } = {},
  ): UiNode => {
    const node = view.button(domMode ? '' : label, x, y, width, height, action, {
      image: options.image,
      pressed: options.pressed,
      fontSize: options.fontSize,
      disabled: options.disabled,
    });
    if (options.accessibleLabel) node.setData('label', options.accessibleLabel);
    else if (label) node.setData('label', label);
    controls.push(node);
    if (sink && label) {
      sink.add({
        key: `cloud-button-${label}`,
        text: label,
        x: x + width / 2,
        y: y + height / 2,
        style: {
          size: options.fontSize ?? Math.min(22, height * 0.42),
          color: options.disabled ? 'rgba(243,222,176,0.40)' : GOLD,
          anchorX: 0.5,
          anchorY: 0.5,
          align: 'center',
          width: Math.max(0, width - 12) || undefined,
          wrap: 'word',
        },
      });
    }
    return node;
  };

  emitButton('', 28, 21, 67, 67, actions.back, {
    image: assets.close,
    pressed: assets.closePressed,
    accessibleLabel: '返回存档',
  });
  emitPageText(`cloud-${serial++}`, '云存档', 600, CLOUD_PAGE.titleY, 760, 49, GOLD, 0.5, 0);
  const panel = CLOUD_PAGE.panel;
  // 原版图框先画，内容全部落在金线内侧的滚动区里。
  view.image(assets.frame, panel.x, panel.y, panel.width, panel.height);
  const left = CLOUD_PAGE.content.left;
  const width = CLOUD_PAGE.content.width;
  const disabled = state.busy || !state.available;

  if (!state.loggedIn) {
    emitPageText(`cloud-${serial++}`, '账号', CLOUD_PAGE.accountLabel.x, CLOUD_PAGE.accountLabel.y, 80, 28);
    emitPageText(`cloud-${serial++}`, '密码', CLOUD_PAGE.passwordLabel.x, CLOUD_PAGE.passwordLabel.y, 80, 28);
    // 两个输入框由 DOM 覆盖层直接盖在标签右侧，不再有单独的输入弹层和入口按钮。
    emitButton('登录', CLOUD_PAGE.login.x, CLOUD_PAGE.login.y, CLOUD_PAGE.login.width, CLOUD_PAGE.login.height,
      actions.login, { fontSize: 30, disabled });
    emitButton('注册', CLOUD_PAGE.register.x, CLOUD_PAGE.register.y, CLOUD_PAGE.register.width, CLOUD_PAGE.register.height,
      actions.register, { fontSize: 30, disabled });

    const note = view.scroll(CLOUD_PAGE.note.x, CLOUD_PAGE.note.y, CLOUD_PAGE.note.width, CLOUD_PAGE.note.height);
    emitNoteText(
      note,
      '账号 3–24 位字母、数字、下划线或汉字，不区分大小写；密码 6–64 位，区分大小写。'
      + '连续输错 3 次锁定 15 分钟；同一账号只允许一处登录。忘记密码无法找回。',
      0, 0, width, 18, TEXT_COLORS.secondary,
    );
    drawStatus(view, state, 0, 72, width, note.content, note, sink);
    note.setHeight(260);
    return { texts, controls, scroll: note };
  }

  emitPageText('cloud-account', `已登录：${state.account}`, left, CLOUD_PAGE.content.top, width - 180, 30);
  emitButton('修改密码', CLOUD_PAGE.changePassword.x, CLOUD_PAGE.changePassword.y,
    CLOUD_PAGE.changePassword.width, CLOUD_PAGE.changePassword.height, actions.changePassword,
    { fontSize: 22, disabled });
  emitPageText(
    'cloud-count',
    state.cloudCount === undefined ? '云端存档：正在读取…' : `云端存档：${state.cloudCount} 个`,
    left, CLOUD_PAGE.content.top + 48, width, 22, TEXT_COLORS.secondary,
  );
  emitButton('导入本机存档', CLOUD_PAGE.actions.x, CLOUD_PAGE.actions.y,
    CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.upload, { fontSize: 23, disabled });
  emitButton('下载云存档', CLOUD_PAGE.actions.x + CLOUD_PAGE.actions.step, CLOUD_PAGE.actions.y,
    CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.download, { fontSize: 23, disabled });
  emitButton('退出登录', CLOUD_PAGE.actions.x + CLOUD_PAGE.actions.step * 2, CLOUD_PAGE.actions.y,
    CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.logout, { fontSize: 23, disabled });

  const note = view.scroll(CLOUD_PAGE.loggedInNote.x, CLOUD_PAGE.loggedInNote.y,
    CLOUD_PAGE.loggedInNote.width, CLOUD_PAGE.loggedInNote.height);
  emitNoteText(note, '导入：把本机现有存档上传到云端。', 0, 0, width, 20, TEXT_COLORS.secondary);
  emitNoteText(note, '下载：把云端存档写回本机同号槽位；覆盖后本机原内容无法恢复。', 0, 30, width, 20, TEXT_COLORS.secondary);
  drawStatus(view, state, 0, 72, width, note.content, note, sink);
  note.setHeight(260);
  return { texts, controls, scroll: note };
}
