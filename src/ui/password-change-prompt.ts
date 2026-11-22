import { skinPrompt, placePrompt } from './dom/prompt-shell.ts';
import {
  CLOUD_NEW_PASSWORD_SAME_MESSAGE,
  CLOUD_PASSWORD_MAX_LENGTH,
  validateCloudPassword,
} from '../domain/cloud-save.ts';

interface PasswordChangePromptOptions {
  onConfirm(currentPassword: string, newPassword: string): void;
  onCancel(): void;
  /** 当前菜单画布的屏幕倍率；确认/取消据此和同屏菜单按钮同尺寸。 */
  scale?:()=>number;
}

function field(labelText: string, autocomplete: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'password';
  input.maxLength = CLOUD_PASSWORD_MAX_LENGTH;
  input.setAttribute('autocomplete', autocomplete);
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  wrap.append(label, input);
  return { wrap, input };
}

/**
 * 修改云存档密码：当前密码、新密码、确认新密码三个字段。
 *
 * 为什么不用三次单字段输入框：玩家要在一个卡片里核对三个值，分开弹会把“确认密码”
 * 和“当前密码”割裂；密码校验和两次输入是否一致也在这里一次说清。
 */
export class PasswordChangePrompt {
  private root?: HTMLDivElement;
  private form?: HTMLFormElement;
  private currentInput?: HTMLInputElement;
  private newInput?: HTMLInputElement;
  private confirmInput?: HTMLInputElement;
  private error?: HTMLParagraphElement;
  private options?: PasswordChangePromptOptions;
  private readonly cancelOnHide = () => { if (this.options) this.cancel(); };
  private releaseSkin?:()=>void;
  private readonly place=()=>placePrompt(this.form);

  get active(): boolean { return !!this.root; }

  show(options: PasswordChangePromptOptions): void {
    this.close();
    if (typeof document === 'undefined') return;
    this.options = options;
    const root = document.createElement('div');
    root.className = 'text-prompt';
    const form = document.createElement('form');
    form.autocomplete = 'off';
    const title = document.createElement('p');
    title.textContent = '修改云存档密码';
    const hint = document.createElement('p');
    hint.className = 'text-prompt-hint';
    hint.textContent = '当前密码用于确认身份；新密码 6–64 位，区分大小写。';
    const current = field('当前密码', 'current-password');
    const next = field('新密码', 'new-password');
    const confirm = field('确认新密码', 'new-password');
    const error = document.createElement('p');
    error.className = 'text-prompt-error';
    error.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'text-prompt-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '确定';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    actions.append(submit, cancel);
    form.append(title, hint, current.wrap, next.wrap, confirm.wrap, error, actions);
    this.releaseSkin=skinPrompt(form,title,actions,options.scale);
    root.append(form);
    document.body.append(root);
    this.root = root; this.form = form;
    this.currentInput = current.input; this.newInput = next.input; this.confirmInput = confirm.input;
    this.error = error;
    const clearError = (): void => { error.hidden = true; error.textContent = ''; };
    for (const input of [current.input, next.input, confirm.input]) {
      input.addEventListener('input', clearError);
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
      });
    }
    form.addEventListener('submit', event => { event.preventDefault(); this.confirm(); });
    cancel.addEventListener('click', () => this.cancel());
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this.cancelOnHide, { once: true });
      window.addEventListener('resize', this.place);
      window.visualViewport?.addEventListener('resize', this.place);
      window.visualViewport?.addEventListener('scroll', this.place);
    }
    this.place();
    current.input.focus();
  }

  close(): void {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.cancelOnHide);
      window.removeEventListener('resize', this.place);
      window.visualViewport?.removeEventListener('resize', this.place);
      window.visualViewport?.removeEventListener('scroll', this.place);
    }
    for (const input of [this.currentInput, this.newInput, this.confirmInput]) {
      if (input) { try { input.blur(); } catch { /* 页面正在销毁 */ } }
    }
    this.releaseSkin?.();this.releaseSkin=undefined;
    this.root?.remove();
    this.root = undefined; this.form = undefined;
    this.currentInput = undefined; this.newInput = undefined; this.confirmInput = undefined;
    this.error = undefined; this.options = undefined;
  }

  private fail(message: string, focus?: HTMLInputElement): void {
    if (this.error) {
      this.error.hidden = false;
      this.error.textContent = message;
    }
    focus?.focus();
  }

  private confirm(): void {
    const options = this.options;
    if (!options) return;
    const currentPassword = this.currentInput?.value ?? '';
    const newPassword = this.newInput?.value ?? '';
    const confirmPassword = this.confirmInput?.value ?? '';
    if (!currentPassword) { this.fail('请输入当前密码。', this.currentInput); return; }
    const problem = validateCloudPassword(newPassword);
    if (problem) { this.fail(problem, this.newInput); return; }
    if (newPassword !== confirmPassword) { this.fail('两次输入的新密码不一致。', this.confirmInput); return; }
    if (newPassword === currentPassword) { this.fail(CLOUD_NEW_PASSWORD_SAME_MESSAGE, this.newInput); return; }
    this.options = undefined;
    this.close();
    options.onConfirm(currentPassword, newPassword);
  }

  private cancel(): void {
    const options = this.options;
    this.options = undefined;
    this.close();
    options?.onCancel();
  }
}
