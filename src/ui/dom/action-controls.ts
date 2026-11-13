import type { ActionControlsHandlers } from '../../rendering/action-controls.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import { SHORTCUT_SLOT_COUNT } from '../../domain/shortcut-bar.ts';
import { CONTROL_SIZES, resolveControlLayout, type ControlViewport, type ControlLayoutOverrides, type ControlId } from '../control-layout.ts';
import { SLOT_ICON_SIZE, ITEM_ICON_SIZE, type ShortcutSlot } from '../shortcut-view.ts';
import { ActionPressGate } from '../action-press-gate.ts';
import { domAssets, type DomAssets } from './assets.ts';
import { DomButton, DomComponent, DomImage } from './components.ts';
import { DomCooldown } from './cooldown.ts';

/** 快捷位按钮的圆形热区半径；比 94 见方的外框小一圈。 */
const SLOT_HIT_RADIUS = 40;
/** 物品数量角标：中心在控件中心右下方 (32,23)，底图 38×40，数字 18px。 */
export const QUANTITY_BADGE = {
  centerX: 32, centerY: 23, width: 38, height: 40, fontSize: 18, maxTextSize: 30
} as const;

interface Control {
  button: DomButton;
  icon: DomImage;
  badge: DomComponent;
  quantity: HTMLElement;
  cooldown: DomCooldown;
  usable: boolean;
  size: number;
  iconKey?: string;
  stateKey?: string;
}

/** 轮盘的图片、数量、冷却与命中全部属于 DOM。 */
export class DomActionControls extends DomComponent {
  private readonly assets: DomAssets;
  private readonly gate = new ActionPressGate();
  private readonly slots: Control[] = [];
  private readonly attack: Control;
  private readonly swap: Control;
  /** 按钮之间的透明挡板：让轮盘范围内的空白也先于地图接收输入。 */
  private readonly shield: DomComponent;
  private page: readonly ShortcutSlot[] = [];
  private cooldowns: Readonly<Record<string, Cooldown>> = {};
  private readonly skin: ControlSkin;
  private readonly handlers: ActionControlsHandlers;
  private readonly failed: (error: unknown) => void;
  constructor(parent: HTMLElement, skin: ControlSkin, handlers: ActionControlsHandlers, failed: (error: unknown) => void, assets = domAssets) {
    super(parent); this.skin = skin; this.handlers = handlers; this.failed = failed; this.assets = assets;
    Object.assign(this.element.style, { inset: '0', width: '100%', height: '100%' });
    // 挡板先建，按钮后建并叠在它上面；空白处由挡板接住，按钮本体仍走自己的圆形热区。
    this.shield = new DomComponent(this);
    Object.assign(this.shield.element.style, { pointerEvents: 'auto', touchAction: 'none' });
    this.shield.element.setAttribute('aria-hidden', 'true');
    this.attack = this.control(CONTROL_SIZES.attack.width, [skin.button], skin['button-pressed'], () => handlers.attack(), CONTROL_SIZES.attack.height);
    for (let index = 0; index < SHORTCUT_SLOT_COUNT; index++) {
      this.slots.push(this.control(CONTROL_SIZES.slot.width, [skin['slot-shadow'], skin['slot-ring']], skin['slot-pressed'], () => this.activate(index)));
    }
    this.swap = this.control(CONTROL_SIZES.swap.width, [skin.swap], skin['swap-pressed'], () => handlers.swap());
    this.own(() => this.resetInput());
    this.visible(false);
  }
  private image(parent: DomComponent, file: string, width: number, x = -width / 2, y = -width / 2, height = width): DomImage {
    const image = new DomImage(parent).rect({ x, y, width, height });
    void image.load(this.assets, file).catch(error => { if (!image.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error); });
    return image;
  }
  private control(width: number, files: string[], pressed: string, action: () => void, height = width): Control {
    let control!: Control;
    const hitRadius = width === CONTROL_SIZES.slot.width ? SLOT_HIT_RADIUS : width / 2;
    const button: DomButton = new DomButton(this, { enabled: () => !this.element.hidden && control.usable,
      circleRadius: hitRadius,
      hitTest: event => {
        const bounds = button.element.getBoundingClientRect();
        const dx = ((event.clientX - bounds.left) / bounds.width - .5) * width;
        const dy = ((event.clientY - bounds.top) / bounds.height - .5) * height;
        return dx * dx + dy * dy <= hitRadius ** 2;
      },
      press: id => this.gate.press(id), release: id => this.gate.release(id), trigger: 'down', action });
    button.rect({ x: 0, y: 0, width, height });
    button.element.style.borderRadius = '50%';
    // 图片以按钮中心为原点，按钮自身的命中区域保持原来的圆形范围。
    const face = new DomComponent(button).rect({ x: width / 2, y: height / 2, width: 0, height: 0 });
    for (const file of files) this.image(face, file, width, -width / 2, -height / 2, height);
    const icon = new DomImage(face);
    const cooldown = new DomCooldown(icon, 'top-left');
    this.image(face, pressed, width, -width / 2, -height / 2, height).element.classList.add('dom-control-pressed');
    const badge = new DomComponent(face).rect({ x: QUANTITY_BADGE.centerX, y: QUANTITY_BADGE.centerY, width: 0, height: 0 });
    this.image(badge, this.skin['quantity-badge'], QUANTITY_BADGE.width,
      -QUANTITY_BADGE.width / 2, -QUANTITY_BADGE.height / 2, QUANTITY_BADGE.height);
    const quantity = document.createElement('span');
    Object.assign(quantity.style, { position: 'absolute', transform: 'translate(-50%,-50%)', fontSize: `${QUANTITY_BADGE.fontSize}px`, color: '#fff', lineHeight: '1' });
    badge.element.appendChild(quantity); badge.visible(false);
    control = { button, icon, badge, quantity, cooldown, usable: true, size: SLOT_ICON_SIZE };
    return control;
  }
  private activate(index: number): void {
    const entry = this.page[index]?.entry;
    if (entry?.kind === 'skill') this.handlers.skill(entry.id);
    else if (entry) this.handlers.item?.(entry.id);
  }
  setShortcutPage(page: readonly ShortcutSlot[]): void { this.page = page.map(slot => ({ ...slot })); this.paint(); }
  setCooldowns(cooldowns: Readonly<Record<string, Cooldown>>): void { this.cooldowns = cooldowns; this.paint(); }
  snapshot(): readonly ShortcutSlot[] {
    return this.page.map(slot => { const cooldown = this.cooldown(slot); return { ...slot, entry: slot.entry ? { ...slot.entry } : null, cooldown: cooldown ? { ...cooldown } : undefined }; });
  }
  private cooldown(slot: ShortcutSlot): Cooldown | undefined { return slot.entry?.kind === 'skill' ? this.cooldowns[slot.entry.id] : slot.cooldown; }
  setAttack(enabled: boolean, dimUnavailable = true): void {
    this.attack.usable = enabled; this.attack.button.element.style.opacity = enabled || !dimUnavailable ? '1' : '.4';
  }
  private paint(): void {
    this.slots.forEach((control, index) => {
      const slot = this.page[index], item = slot?.entry?.kind === 'item';
      const size = item ? ITEM_ICON_SIZE : SLOT_ICON_SIZE;
      const file = slot?.entry ? slot.icon : undefined;
      const cooldown = slot ? this.cooldown(slot) : undefined, cooling = !!cooldown && cooldown.remainingMs > 0;
      const usable = !!slot?.entry && !cooling && (item ? slot.quantity > 0 : slot.enabled);
      const opacity = slot?.entry && !usable && !cooling ? '.4' : '1';
      control.cooldown.update(cooldown, size / 2);
      const stateKey = `${file}|${size}|${item}|${slot?.quantity}|${usable}|${opacity}`;
      if (stateKey === control.stateKey) return;
      control.stateKey = stateKey;
      if (control.iconKey !== file || control.size !== size) {
        control.iconKey = file; control.size = size;
        control.icon.rect({ x: -size / 2, y: -size / 2, width: size, height: size }).visible(!!file);
        if (file) void control.icon.load(this.assets, file).catch(error => { if (!control.icon.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error); });
      }
      control.badge.visible(!!item); control.quantity.textContent = item ? String(slot.quantity) : '';
      control.usable = usable;
      control.icon.element.style.opacity = opacity; control.badge.element.style.opacity = opacity;
    });
  }
  layout(viewport: ControlViewport, overrides?: ControlLayoutOverrides): void {
    const points = resolveControlLayout(viewport, overrides);
    // 挡板覆盖整组动作按钮的外接矩形，按钮之间的空隙也不会再落给地图。
    const shielded: ControlId[] = ['attack', 'swap',
      ...Array.from({ length: SHORTCUT_SLOT_COUNT }, (_, index) => `slot-${index}` as ControlId)];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const id of shielded) {
      const point = points[id];
      left = Math.min(left, point.x - point.width / 2); top = Math.min(top, point.y - point.height / 2);
      right = Math.max(right, point.x + point.width / 2); bottom = Math.max(bottom, point.y + point.height / 2);
    }
    const padding = 8;
    this.shield.rect({ x: left - padding, y: top - padding,
      width: right - left + padding * 2, height: bottom - top + padding * 2 });
    const place = (control: Control, id: ControlId) => {
      const point = points[id], factor = point.scale * point.userScale;
      control.button.element.style.left = `${point.x}px`; control.button.element.style.top = `${point.y}px`;
      control.button.element.style.transformOrigin = '0 0';
      control.button.element.style.transform = `scale(${factor}) translate(-50%,-50%)`;
    };
    place(this.attack, 'attack'); place(this.swap, 'swap');
    this.slots.forEach((control, index) => place(control, `slot-${index}` as ControlId));
  }
  resetInput(): void { this.gate.reset(); for (const control of [this.attack, ...this.slots, this.swap]) control.button.reset(); }
  override visible(shown: boolean): this { if (!shown) this.resetInput(); return super.visible(shown); }
}
