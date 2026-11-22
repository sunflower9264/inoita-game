import { portraitFit } from '../portrait-fit.ts';
import type { AssetLease } from '../../application/assets.ts';
import type { DomAssets, DomImageSource } from './assets.ts';

export interface DomRect { x: number; y: number; width: number; height: number }

/** 一组节点共享取消与清理；父组件销毁会先取消其全部子组件。 */
export class DomComponent {
  readonly element: HTMLElement;
  readonly controller = new AbortController();
  private readonly disposers = new Set<() => void>();
  constructor(parent: HTMLElement | DomComponent, tag = 'div') {
    this.element = document.createElement(tag);
    Object.assign(this.element.style, { position: 'absolute', pointerEvents: 'none' });
    if (parent instanceof DomComponent) {
      parent.element.appendChild(this.element);
      const detach = parent.own(() => this.destroy());
      this.own(detach);
    } else parent.appendChild(this.element);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  own(dispose: () => void): () => void {
    if (this.signal.aborted) { dispose(); return () => {}; }
    this.disposers.add(dispose);
    return () => { this.disposers.delete(dispose); };
  }
  rect(rect: DomRect): this {
    Object.assign(this.element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    return this;
  }
  visible(shown: boolean): this { if (this.element.hidden === shown) this.element.hidden = !shown; return this; }
  destroy(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.element.remove();
  }
}

/** 图集与独立图片共用一套裁剪，原始像素交给浏览器缩放。 */
export class DomImage extends DomComponent {
  private readonly picture: HTMLImageElement;
  private lease?: AssetLease;
  private request?: AbortController;
  private source?: DomImageSource;
  private box: DomRect = { x: 0, y: 0, width: 1, height: 1 };
  private fit: 'stretch' | 'cover' | 'contain' = 'stretch';
  private anchorX = .5;
  private anchorY = .5;
  private naturalAnchor?: { x: number; y: number };
  constructor(parent: HTMLElement | DomComponent) {
    super(parent);
    this.element.style.overflow = 'hidden';
    this.picture = document.createElement('img');
    this.picture.alt = '';
    this.picture.draggable = false;
    Object.assign(this.picture.style, { position: 'absolute', maxWidth: 'none', pointerEvents: 'none' });
    this.element.appendChild(this.picture);
    this.own(() => { this.request?.abort(); this.lease?.release(); });
  }
  override rect(rect: DomRect): this { this.box = rect; super.rect(rect); this.layout(); return this; }
  fitting(fit: 'stretch' | 'cover' | 'contain', anchorX = .5, anchorY = .5): this {
    this.fit = fit; this.anchorX = anchorX; this.anchorY = anchorY; this.layout(); return this;
  }
  naturalSize(anchorX = 0, anchorY = 0): this {
    this.naturalAnchor = { x: anchorX, y: anchorY }; this.layout(); return this;
  }
  async load(assets: DomAssets, file: string): Promise<void> {
    this.signal.throwIfAborted();
    this.request?.abort();
    const request = this.request = new AbortController();
    try {
      const lease = await assets.acquire(file, request.signal);
      if (this.signal.aborted || this.request !== request) { lease.release(); return; }
      this.lease?.release(); this.lease = lease; this.source = lease.source;
      this.picture.hidden = false;
      this.picture.src = lease.source.url;
      this.layout();
    } catch (error) {
      if (this.request === request && !request.signal.aborted) this.clear();
      throw error;
    }
  }
  /** 加载失败时不能继续显示上一张图；释放旧租约并清掉画面。 */
  private clear(): void {
    this.lease?.release(); this.lease = undefined; this.source = undefined;
    this.picture.hidden = true;
    if (typeof this.picture.removeAttribute === 'function') this.picture.removeAttribute('src');
  }
  private layout(): void {
    if (!this.source) return;
    const { frame, width, height } = this.source;
    if (this.naturalAnchor) {
      this.box = { ...this.box, width: frame.width, height: frame.height };
      Object.assign(this.element.style, { width: `${frame.width}px`, height: `${frame.height}px`,
        transform: `translate(${-this.naturalAnchor.x * 100}%,${-this.naturalAnchor.y * 100}%)` });
    }
    let sx = this.box.width / frame.width, sy = this.box.height / frame.height, left = 0, top = 0;
    if (this.fit === 'cover') {
      const fit = portraitFit(frame, this.box, this.anchorX, this.anchorY);
      sx = sy = fit.scale; left = -fit.cropX * sx; top = -fit.cropY * sy;
    } else if (this.fit === 'contain') {
      sx = sy = Math.min(sx, sy);
      left = (this.box.width - frame.width * sx) * this.anchorX;
      top = (this.box.height - frame.height * sy) * this.anchorY;
    }
    Object.assign(this.picture.style, { width: `${width * sx}px`, height: `${height * sy}px`,
      left: `${left - frame.x * sx}px`, top: `${top - frame.y * sy}px` });
  }
}

export interface DomPressOptions {
  enabled(): boolean;
  circleRadius?: number;
  hitTest?(event: PointerEvent): boolean;
  press?(pointer: number): boolean;
  release?(pointer: number): void;
  trigger: 'down' | 'up';
  action(): void;
}

/** 只管理一次手势；全局动作互斥由调用方共享的 ActionPressGate 决定。 */
export class DomButton extends DomComponent {
  private pointer?: number;
  private readonly options: DomPressOptions;
  constructor(parent: HTMLElement | DomComponent, options: DomPressOptions) {
    super(parent, 'button'); this.options = options;
    (this.element as HTMLButtonElement).type = 'button';
    Object.assign(this.element.style, { pointerEvents: 'none', touchAction: 'none', padding: '0', border: '0', background: 'none' });
    const hit = document.createElement('span');
    Object.assign(hit.style, { position: 'absolute', top: '0', right: '0', bottom: '0', left: '0', pointerEvents: 'auto', touchAction: 'none' });
    if (options.circleRadius !== undefined) hit.style.clipPath = `circle(${options.circleRadius}px at 50% 50%)`;
    this.element.appendChild(hit);
    const listen = (name: string, action: EventListener) => {
      this.element.addEventListener(name, action);
      this.own(() => this.element.removeEventListener(name, action));
    };
    listen('pointerdown', event => this.down(event as PointerEvent));
    listen('pointerup', event => this.up(event as PointerEvent));
    for (const name of ['pointercancel', 'lostpointercapture']) listen(name, event => {
      if ((event as PointerEvent).pointerId === this.pointer) this.reset();
    });
    listen('click', event => { event.preventDefault(); event.stopPropagation(); });
    this.own(() => this.reset());
  }
  private down(event: PointerEvent): void {
    event.stopPropagation(); event.preventDefault();
    if (event.button !== 0 || this.pointer !== undefined || !this.options.enabled() || this.options.hitTest?.(event) === false) return;
    if (this.options.press && !this.options.press(event.pointerId)) return;
    this.pointer = event.pointerId;
    this.element.setPointerCapture(event.pointerId);
    this.element.dataset.pressed = 'true';
    if (this.options.trigger === 'down') this.options.action();
  }
  private up(event: PointerEvent): void {
    event.stopPropagation(); event.preventDefault();
    if (event.pointerId !== this.pointer) return;
    const bounds = this.element.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
    const activate = inside && this.options.trigger === 'up' && this.options.enabled();
    this.reset();
    if (activate) this.options.action();
  }
  reset(): void {
    const pointer = this.pointer; this.pointer = undefined;
    delete this.element.dataset.pressed;
    if (pointer !== undefined) {
      this.options.release?.(pointer);
      if (this.element.hasPointerCapture(pointer)) this.element.releasePointerCapture(pointer);
    }
  }
  override visible(shown: boolean): this { if (!shown) this.reset(); return super.visible(shown); }
}
