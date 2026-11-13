import { CLOUD_ACCOUNT_MAX_LENGTH, CLOUD_PASSWORD_MAX_LENGTH, sanitizeCloudAccountInput } from '../domain/cloud-save.ts';
import { FONT } from './text-style.ts';

/** 画框内的 CSS 矩形；由页面的 UiSurface 根变换计算。 */
export interface CredentialInputRect {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

interface CloudCredentialsInputOptions {
  onAccount(value: string): void;
  onPassword(value: string): void;
}

/**
 * 云存档页的账号/密码输入框。它们是直接盖在面板对应行上的原生 input，
 * 不再是独立的居中弹层；手机系统键盘仍由真实 input 唤起。
 *
 * 输入框挂在 `#game-frame` 内、使用 CSS 坐标：键盘弹出时画框跟随可视区偏移，
 * 输入框随画框一起移动，贴着面板对应行。
 *
 * 覆盖层只负责输入和定位，值写回场景状态；登录/注册按钮由 DOM 菜单表面绘制。
 */
export class CloudCredentialsInput {
  private readonly options: CloudCredentialsInputOptions;
  private root?: HTMLDivElement;
  private accountInput?: HTMLInputElement;
  private passwordInput?: HTMLInputElement;

  constructor(options: CloudCredentialsInputOptions) {
    this.options = options;
  }

  /** 输入框获得焦点时，场景键盘处理器要让路，避免 Escape 同时退出页面。 */
  get focused(): boolean {
    if (typeof document === 'undefined') return false;
    return document.activeElement === this.accountInput || document.activeElement === this.passwordInput;
  }

  show(): void {
    this.ensure();
    if (this.root) this.root.style.display = 'block';
  }

  hide(): void {
    if (this.focused) this.blur();
    if (this.root) this.root.style.display = 'none';
  }

  blur(): void {
    this.accountInput?.blur();
    this.passwordInput?.blur();
  }

  setValues(account: string, password: string): void {
    this.ensure();
    if (this.accountInput && this.accountInput.value !== account) this.accountInput.value = account;
    if (this.passwordInput && this.passwordInput.value !== password) this.passwordInput.value = password;
  }

  setRects(account: CredentialInputRect, password: CredentialInputRect): void {
    this.ensure();
    this.applyRect(this.accountInput, account);
    this.applyRect(this.passwordInput, password);
  }

  destroy(): void {
    this.blur();
    this.root?.remove();
    this.root = undefined;
    this.accountInput = undefined;
    this.passwordInput = undefined;
  }

  private ensure(): void {
    if (this.root || typeof document === 'undefined') return;
    const root = document.createElement('div');
    root.className = 'cloud-credentials';

    const account = document.createElement('input');
    account.className = 'cloud-credentials-field';
    account.type = 'text';
    account.placeholder = '请输入账号';
    account.maxLength = CLOUD_ACCOUNT_MAX_LENGTH;
    account.setAttribute('autocomplete', 'username');
    account.setAttribute('autocapitalize', 'off');
    account.setAttribute('inputmode', 'text');
    account.setAttribute('enterkeyhint', 'next');
    account.setAttribute('spellcheck', 'false');

    const password = document.createElement('input');
    password.className = 'cloud-credentials-field';
    password.type = 'password';
    password.placeholder = '请输入密码';
    password.maxLength = CLOUD_PASSWORD_MAX_LENGTH;
    password.setAttribute('autocomplete', 'current-password');
    password.setAttribute('autocapitalize', 'off');
    password.setAttribute('enterkeyhint', 'done');
    password.setAttribute('spellcheck', 'false');

    root.append(account, password);
    // 画布容器是 fixed 定位；挂在它里面，输入框跟着画布一起跟随可视区偏移。
    (document.getElementById('game-frame') ?? document.body).append(root);
    this.root = root;
    this.accountInput = account;
    this.passwordInput = password;
    account.style.fontFamily = FONT;
    password.style.fontFamily = FONT;

    account.addEventListener('input', () => {
      const filtered = sanitizeCloudAccountInput(account.value);
      if (filtered !== account.value) {
        const cursor = account.selectionStart ?? filtered.length;
        account.value = filtered;
        try {
          account.setSelectionRange(Math.min(cursor, filtered.length), Math.min(cursor, filtered.length));
        } catch {
          // 某些浏览器在非文本输入状态下不允许设置选区，保持过滤后的值即可。
        }
      }
      this.options.onAccount(filtered);
    });
    password.addEventListener('input', () => this.options.onPassword(password.value));
    account.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      password.focus();
    });
    password.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      // 回车只收起键盘，不替玩家选登录还是注册；注册时误按回车不会被当成一次登录失败。
      event.preventDefault();
      event.stopPropagation();
      this.blur();
    });
  }

  private applyRect(input: HTMLInputElement | undefined, rect: CredentialInputRect): void {
    if (!input) return;
    input.style.left = `${rect.left}px`;
    input.style.top = `${rect.top}px`;
    input.style.width = `${Math.max(1, rect.width)}px`;
    input.style.height = `${Math.max(1, rect.height)}px`;
    // iOS Safari 会把小于 16px 的输入框整体放大；这里保底 16px，避免聚焦时桌面/页面乱缩放。
    input.style.fontSize = `${Math.max(16, rect.fontSize)}px`;
  }
}
