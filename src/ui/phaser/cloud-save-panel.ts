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
import type { UiSurface } from './widgets.ts';

interface CloudSavePageAssets {
  frame: string;
  close: string;
  closePressed: string;
}

function drawStatus(
  view: UiSurface,
  state: CloudPageState,
  left: number,
  y: number,
  width: number,
  parent: UiNode,
): void {
  const text=cloudStatusText(state)??(!state.available?'云存档暂不可用，本机存档不受影响。':'');
  const color=!state.available&&!cloudStatusText(state)?TEXT_COLORS.dangerSoft:cloudStatusColor(cloudStatusKind(state));
  view.text(text,left,y,width,22,color,parent);
}

/**
 * 云存档页：账号/密码输入、登录注册，或已登录后的导入/下载/退出。
 * 图框和关闭钮与存档槽页共用；忙碌时只禁用动作，返回钮始终可用。
 */
export function drawCloudSavePage(
  view: UiSurface,
  state: CloudPageState,
  actions: CloudPageActions,
  assets: CloudSavePageAssets,
): void {
  view.button('', 28, 21, 67, 67, actions.back, { image: assets.close, pressed: assets.closePressed })
    .setData('label', '返回存档');
  view.text('云存档', 600, CLOUD_PAGE.titleY, 760, 49).setOrigin(.5, 0);
  const panel = CLOUD_PAGE.panel;
  // 原版图框先画，内容全部落在金线内侧的滚动区里。
  view.image(assets.frame, panel.x, panel.y, panel.width, panel.height);
  const left = CLOUD_PAGE.content.left;
  const width = CLOUD_PAGE.content.width;
  const disabled = state.busy || !state.available;

  if (!state.loggedIn) {
    view.text('账号', CLOUD_PAGE.accountLabel.x, CLOUD_PAGE.accountLabel.y, 80, 28);
    view.text('密码', CLOUD_PAGE.passwordLabel.x, CLOUD_PAGE.passwordLabel.y, 80, 28);
    // 两个输入框由 DOM 覆盖层直接盖在标签右侧，不再有单独的输入弹层和入口按钮。
    view.button('登录', CLOUD_PAGE.login.x, CLOUD_PAGE.login.y, CLOUD_PAGE.login.width, CLOUD_PAGE.login.height,
      actions.login, { fontSize: 30, disabled });
    view.button('注册', CLOUD_PAGE.register.x, CLOUD_PAGE.register.y, CLOUD_PAGE.register.width, CLOUD_PAGE.register.height,
      actions.register, { fontSize: 30, disabled });

    const note = view.scroll(CLOUD_PAGE.note.x, CLOUD_PAGE.note.y, CLOUD_PAGE.note.width, CLOUD_PAGE.note.height);
    view.text(
      '账号 3–24 位字母、数字、下划线或汉字，不区分大小写；密码 6–64 位，区分大小写。'
      + '连续输错 3 次锁定 15 分钟；同一账号只允许一处登录。忘记密码无法找回。',
      0, 0, width, 18, TEXT_COLORS.secondary, note.content,
    );
    drawStatus(view, state, 0, 72, width, note.content);
    note.setHeight(260);
  } else {
    view.text(`已登录：${state.account}`, left, CLOUD_PAGE.content.top, width - 180, 30);
    view.button('修改密码', CLOUD_PAGE.changePassword.x, CLOUD_PAGE.changePassword.y,
      CLOUD_PAGE.changePassword.width, CLOUD_PAGE.changePassword.height, actions.changePassword,
      { fontSize: 22, disabled });
    view.text(
      state.cloudCount === undefined ? '云端存档：正在读取…' : `云端存档：${state.cloudCount} 个`,
      left, CLOUD_PAGE.content.top + 48, width, 22, TEXT_COLORS.secondary,
    );
    view.button('导入本机存档', CLOUD_PAGE.actions.x, CLOUD_PAGE.actions.y,
      CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.upload, { fontSize: 23, disabled });
    view.button('下载云存档', CLOUD_PAGE.actions.x + CLOUD_PAGE.actions.step, CLOUD_PAGE.actions.y,
      CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.download, { fontSize: 23, disabled });
    view.button('退出登录', CLOUD_PAGE.actions.x + CLOUD_PAGE.actions.step * 2, CLOUD_PAGE.actions.y,
      CLOUD_PAGE.actions.width, CLOUD_PAGE.actions.height, actions.logout, { fontSize: 23, disabled });

    const note = view.scroll(CLOUD_PAGE.loggedInNote.x, CLOUD_PAGE.loggedInNote.y,
      CLOUD_PAGE.loggedInNote.width, CLOUD_PAGE.loggedInNote.height);
    view.text('导入：把本机现有存档上传到云端。', 0, 0, width, 20, TEXT_COLORS.secondary, note.content);
    view.text('下载：把云端存档写回本机同号槽位；覆盖后本机原内容无法恢复。',
      0, 30, width, 20, TEXT_COLORS.secondary, note.content);
    drawStatus(view, state, 0, 72, width, note.content);
    note.setHeight(260);
  }
}
