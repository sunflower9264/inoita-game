import type { DomLabel, DomUi } from './dom-ui.ts';

/** 多行文字的默认行高：字号 + 5，与 `UiSurface.text` 的 lineSpacing 一致。 */
const DEFAULT_LINE_SPACING = 5;
/** 弹层打开时页面文字压暗到 35%。 */
const DIMMED_TEXT_OPACITY = '0.35';
/** 对比底色：半透明黑，保证压在游戏画面上的文字可读。 */
const CONTRAST_TEXT_BACKGROUND = 'rgba(0,0,0,.8)';

/** 页面坐标 → 画框内 CSS 坐标与倍率；倍率用来把字号换算到屏幕。 */
export interface MenuTextPoint { x: number; y: number; scale: number }

/** 一段菜单文字；字号和 Phaser `UiSurface.text` 的 size 同一口径。 */
interface MenuTextStyle {
  size: number;
  color?: string;
  contrastBackground?: boolean;
  /** 对应 Phaser 的 `setOrigin`：0 是左/上，.5 是中，1 是右/下。 */
  anchorX?: number;
  anchorY?: number;
  align?: 'left' | 'center' | 'right';
  /** 换行宽度，页面坐标单位；给出后才启用多行，不给出保持单行。 */
  width?: number;
  /** 每行高度，页面坐标单位；默认 `size + 5`，与 `UiSurface.text` 的 lineSpacing 一致。 */
  lineHeight?: number;
  /** 换行模式；默认 `none`（不换行），`word` 按词断，`anywhere` 任意位置断。 */
  wrap?: MenuTextWrap;
}

type MenuTextWrap = 'none' | 'word' | 'anywhere';

/** 滚动视口在页面坐标里的上下边界；越界的行不显示。 */
export interface MenuTextClip { top: number; bottom: number }

/** 不透明弹层在页面坐标里的覆盖矩形；被盖住的文字按矩形裁剪，不整条删除。 */
export interface MenuTextOcclude { left: number; top: number; right: number; bottom: number }

export interface MenuTextSpec {
  /** 同一页内唯一；重绘时按它复用 DOM 标签。 */
  key: string;
  text: string;
  x: number;
  y: number;
  style: MenuTextStyle;
  /** 文字所在滚动区名。给出时 y 会扣掉该区当前偏移。 */
  scroll?: string;
  clip?: MenuTextClip;
  /** 弹层打开时页面文字整体压暗；弹层自己的文字不设。 */
  dim?: boolean;
  /** 不透明弹层的覆盖矩形；落在里面的部分裁掉或隐藏。 */
  occlude?: MenuTextOcclude;
  /** 文字坐标系；默认页面坐标，`modal` 用弹层根节点换算。 */
  space?: 'page' | 'modal';
}

export interface MenuTextWriter { add(spec: MenuTextSpec): void }

/** 一个页面的文字产出函数；新增页面时在这里登记，不重写 `MenuTextLayer`。 */
type MenuTextPageRenderer = (writer: MenuTextWriter) => void;

interface MenuTextEntry {
  label: DomLabel;
  text: string;
  styleKey: string;
  wrapKey: string;
  clipKey: string;
  x: number;
  y: number;
  visible: boolean;
}

/** 一块滚动窗口的裁剪容器；标签挂进去后由浏览器按矩形裁边。 */
interface MenuTextClipBox {
  label: DomLabel;
  top: number;
  height: number;
}

/**
 * 菜单页面的 DOM 文字层。
 *
 * 图框、按钮和滑条由 DOM 组件绘制；这里统一管理页面文字与滚动裁剪。
 * 页面重绘时按 key 复用标签，内容、字号和位置都没变就不写 DOM。滚动和窗口
 * 缩放由宿主调用 `refresh()`，这里只重算位置，不重建标签。
 */
export class MenuTextLayer {
  private readonly dom: Pick<DomUi, 'label'>;
  private readonly pointOf: (x: number, y: number) => MenuTextPoint;
  private readonly modalPointOf?: (x: number, y: number) => MenuTextPoint;
  private readonly scrollTopOf: (page: string, scroll: string) => number | undefined;
  private readonly renderers = new Map<string, MenuTextPageRenderer>();
  private readonly entries = new Map<string, MenuTextEntry>();
  private readonly clips = new Map<string, MenuTextClipBox>();
  private baseLayer?: HTMLElement;
  private specs: MenuTextSpec[] = [];
  private page = '';
  private shown = true;
  private signature = '';

  constructor(
    dom: Pick<DomUi, 'label'>,
    pointOf: (x: number, y: number) => MenuTextPoint,
    scrollTopOf: (page: string, scroll: string) => number | undefined,
    modalPointOf?: (x: number, y: number) => MenuTextPoint
  ) {
    this.dom = dom;
    this.pointOf = pointOf;
    this.modalPointOf = modalPointOf;
    this.scrollTopOf = scrollTopOf;
  }

  /** 页面文字用页面坐标，更新日志这类画在弹层上的文字用弹层坐标。 */
  private pointFor(spec: MenuTextSpec): (x: number, y: number) => MenuTextPoint {
    return spec.space === 'modal' && this.modalPointOf ? this.modalPointOf : this.pointOf;
  }

  /** 登记一个页面的文字渲染函数；同一页重复登记会替换。 */
  register(page: string, renderer: MenuTextPageRenderer): void {
    this.renderers.set(page, renderer);
  }

  /** 切页时保留标签，交给新页面复用并移除不再需要的标签。 */
  beginPage(page: string): void {
    if (page === this.page) return;
    this.page = page;
    if (!page) {
      this.clearEntries();
      this.specs = [];
    }
  }

  /** 按登记的函数重建当前页文字；没有登记函数的页面只保留空层。 */
  renderPage(page: string): void {
    this.beginPage(page);
    const specs: MenuTextSpec[] = [];
    this.renderers.get(page)?.({ add: spec => specs.push(spec) });
    this.specs = specs;
    this.apply();
  }

  /** 滚动、窗口缩放后重新换算位置；不会重建标签。 */
  refresh(): void {
    this.apply();
  }

  /** 菜单整体隐藏或让位给弹层时调用。 */
  setVisible(visible: boolean): void {
    if (this.shown === visible) return;
    this.shown = visible;
    for (const entry of this.entries.values()) entry.label.setVisible(visible && entry.visible);
    for (const clip of this.clips.values()) clip.label.setVisible(visible);
  }

  /** 滑条这类不走整页重绘的值：只改一条已存在的文字。 */
  setText(page: string, key: string, text: string): void {
    if (page !== this.page) return;
    const spec = this.specs.find(value => value.key === key);
    if (spec) spec.text = text;
    const entry = this.entries.get(key);
    if (!entry || entry.text === text) return;
    entry.text = text;
    entry.label.setText(text);
    this.signature = '';
  }

  destroy(): void {
    this.clearEntries();
    this.specs = [];
    this.renderers.clear();
    this.page = '';
  }

  private clearEntries(): void {
    for (const entry of this.entries.values()) entry.label.remove();
    for (const clip of this.clips.values()) clip.label.remove();
    this.entries.clear();
    this.clips.clear();
    this.baseLayer = undefined;
    this.signature = '';
  }

  private newLabel(className: string, anchor: MenuTextPoint | { x: number; y: number }): DomLabel {
    const label = this.dom.label('screen', className, anchor);
    this.baseLayer ??= label.element.parentElement ?? undefined;
    return label;
  }

  /** 同一组上下边界共用一个裁剪容器；滚动时只换标签位置，容器不动。 */
  private clipBox(spec: MenuTextSpec): MenuTextClipBox | undefined {
    if (!spec.clip) return undefined;
    const key = `${spec.space ?? 'page'}|${spec.clip.top}|${spec.clip.bottom}`;
    let box = this.clips.get(key);
    if (!box) {
      box = { label: this.newLabel('dom-menu-clip', { x: 0, y: 0 }), top: NaN, height: NaN };
      box.label.setVisible(false);
      this.clips.set(key, box);
    }
    const pointOf = this.pointFor(spec);
    const top = pointOf(0, spec.clip.top).y;
    const height = Math.max(0, pointOf(0, spec.clip.bottom).y - top);
    if (box.top !== top || box.height !== height) {
      box.top = top;
      box.height = height;
      box.label.setStyle({ left: '0px', top: '0px', width: '100%', height: `${height.toFixed(2)}px` })
        .setPosition(0, top).setVisible(this.shown);
    }
    return box;
  }

  private bodyY(spec: MenuTextSpec): number {
    if (!spec.scroll) return spec.y;
    return spec.y - (this.scrollTopOf(this.page, spec.scroll) ?? 0);
  }

  private withinClip(spec: MenuTextSpec, y: number): boolean {
    if (!spec.clip) return true;
    // 只隐藏完全滚出视口的标签；部分露出的行交给外层 overflow:hidden 裁边。
    const box = this.textBox(spec, y);
    return box.bottom > spec.clip.top && box.top < spec.clip.bottom;
  }

  private lineHeightOf(style: MenuTextStyle): number {
    return style.lineHeight ?? style.size + DEFAULT_LINE_SPACING;
  }

  /**
   * 多行样式。没给宽度时返回空 key，让标签沿用 `.dom-label` 的单行样式；
   * 从多行改回单行时再写一次重置值，避免样式留在复用标签上。
   */
  private wrappingOf(style: MenuTextStyle, scale: number): { key: string; css: Partial<CSSStyleDeclaration> } {
    if (style.width === undefined) {
      return {
        key: '',
        css: { whiteSpace: 'nowrap', overflowWrap: 'normal', width: '', lineHeight: '' }
      };
    }
    const wrap = style.wrap ?? 'none';
    const width = Math.max(0, style.width * scale);
    const lineHeight = Math.max(0, this.lineHeightOf(style) * scale);
    const overflowWrap = wrap === 'word' ? 'break-word' : wrap === 'anywhere' ? 'anywhere' : 'normal';
    return {
      key: `${width.toFixed(2)}|${lineHeight.toFixed(2)}|${wrap}`,
      css: {
        whiteSpace: 'pre-wrap',
        overflowWrap,
        width: `${width.toFixed(2)}px`,
        lineHeight: `${lineHeight.toFixed(2)}px`
      }
    };
  }

  /**
   * 文字的页面坐标包围盒。有换行宽度时用整列宽，行数按字符数估算；
   * 单行文字用字数和字号估算，只用于判断是否整条落进弹层。
   */
  private textBox(spec: MenuTextSpec, y: number): {
    left: number; top: number; right: number; bottom: number; fixedWidth: boolean;
  } {
    const width = spec.style.width ?? Array.from(spec.text).length * spec.style.size;
    const lineHeight = this.lineHeightOf(spec.style);
    const lines = spec.style.width
      ? Math.max(1, Math.ceil(Array.from(spec.text).length * spec.style.size / Math.max(1, spec.style.width)))
      : 1;
    const height = lineHeight * lines;
    const left = spec.x - (spec.style.anchorX ?? 0) * width;
    const top = y - (spec.style.anchorY ?? 0) * height;
    return { left, top, right: left + width, bottom: top + height, fixedWidth: spec.style.width !== undefined };
  }

  /**
   * 弹层遮挡：有固定换行宽度的文字按矩形裁边；单行文字拿不到稳定盒宽，
   * 只有整条落在弹层里才隐藏。裁剪值换算成标签自身的 CSS 像素。
   */
  private occlusionClip(spec: MenuTextSpec, y: number, scale: number): { key: string; visible: boolean; css: string } {
    const rect = spec.occlude;
    if (!rect) return { key: '', visible: true, css: '' };
    const box = this.textBox(spec, y);
    if (box.right <= rect.left || box.left >= rect.right || box.bottom <= rect.top || box.top >= rect.bottom) {
      return { key: '', visible: true, css: '' };
    }
    const coverX = box.left >= rect.left && box.right <= rect.right;
    const coverY = box.top >= rect.top && box.bottom <= rect.bottom;
    if (coverX && coverY) return { key: 'hidden', visible: false, css: '' };
    // 横带这类全宽遮挡：只裁被盖住的上/下几行，保留没被盖住的部分。
    if (coverX) {
      if (rect.top <= box.top && rect.bottom < box.bottom) {
        const amount = Math.max(0, rect.bottom - box.top) * scale;
        return { key: `top:${amount.toFixed(2)}`, visible: true, css: `inset(${amount.toFixed(2)}px 0 0 0)` };
      }
      if (rect.top > box.top && rect.bottom >= box.bottom) {
        const amount = Math.max(0, box.bottom - rect.top) * scale;
        return { key: `bottom:${amount.toFixed(2)}`, visible: true, css: `inset(0 0 ${amount.toFixed(2)}px 0)` };
      }
      return { key: 'hidden', visible: false, css: '' };
    }
    // 操作弹层这类全高遮挡：只裁左边或右边的一段。单行文字拿不到稳定盒宽时整条保留。
    if (coverY && box.fixedWidth) {
      if (rect.left <= box.left && rect.right < box.right) {
        const amount = Math.max(0, rect.right - box.left) * scale;
        return { key: `left:${amount.toFixed(2)}`, visible: true, css: `inset(0 0 0 ${amount.toFixed(2)}px)` };
      }
      if (rect.left > box.left && rect.right >= box.right) {
        const amount = Math.max(0, box.right - rect.left) * scale;
        return { key: `right:${amount.toFixed(2)}`, visible: true, css: `inset(0 ${amount.toFixed(2)}px 0 0)` };
      }
    }
    if (!box.fixedWidth) return { key: '', visible: true, css: '' };
    // 只盖住一个角时用 polygon 切掉被盖住的那一块，保留其余行。
    const width = (box.right - box.left) * scale, height = (box.bottom - box.top) * scale;
    if (width <= 0 || height <= 0) return { key: '', visible: true, css: '' };
    const x1 = Math.min(width, Math.max(0, (rect.left - box.left) * scale));
    const x2 = Math.min(width, Math.max(0, (rect.right - box.left) * scale));
    const y1 = Math.min(height, Math.max(0, (rect.top - box.top) * scale));
    const y2 = Math.min(height, Math.max(0, (rect.bottom - box.top) * scale));
    const coversLeft = rect.left <= box.left, coversRight = rect.right >= box.right;
    const coversTop = rect.top <= box.top, coversBottom = rect.bottom >= box.bottom;
    let points: string | undefined;
    if (coversTop && coversLeft && !coversRight && !coversBottom) {
      points = `${x2}px 0, ${width}px 0, ${width}px ${height}px, 0 ${height}px, 0 ${y2}px, ${x2}px ${y2}px`;
    } else if (coversTop && coversRight && !coversLeft && !coversBottom) {
      points = `0 0, ${x1}px 0, ${x1}px ${y2}px, ${width}px ${y2}px, ${width}px ${height}px, 0 ${height}px`;
    } else if (coversBottom && coversLeft && !coversTop && !coversRight) {
      points = `0 0, ${width}px 0, ${width}px ${height}px, ${x2}px ${height}px, ${x2}px ${y1}px, 0 ${y1}px`;
    } else if (coversBottom && coversRight && !coversTop && !coversLeft) {
      points = `0 0, ${width}px 0, ${width}px ${y1}px, ${x1}px ${y1}px, ${x1}px ${height}px, 0 ${height}px`;
    }
    if (points) return { key: `corner:${points}`, visible: true, css: `polygon(${points})` };
    return { key: 'hidden', visible: false, css: '' };
  }

  private apply(): void {
    if (!this.specs.length) {
      this.clearEntries();
      return;
    }
    const origin = this.pointOf(0, 0), modalOrigin = this.modalPointOf?.(0, 0);
    const signature = JSON.stringify([this.page, origin.x, origin.y, origin.scale,
      modalOrigin?.x ?? null, modalOrigin?.y ?? null, modalOrigin?.scale ?? null, ...this.specs.map(spec => {
      const y = this.bodyY(spec);
      return [spec.key, spec.text, spec.style.size, spec.style.color ?? '', !!spec.style.contrastBackground, spec.style.anchorX ?? 0,
        spec.style.anchorY ?? 0, spec.style.align ?? 'left', spec.x, y, this.withinClip(spec, y),
        spec.style.width ?? null, this.lineHeightOf(spec.style), spec.style.wrap ?? 'none',
        spec.clip ? [spec.clip.top, spec.clip.bottom] : null,
        spec.dim ? 1 : 0, spec.space ?? 'page',
        spec.occlude ? [spec.occlude.left, spec.occlude.top, spec.occlude.right, spec.occlude.bottom] : null];
    })]);
    if (signature === this.signature) return;
    this.signature = signature;

    const seen = new Set<string>(), usedClips = new Set<string>();
    for (const spec of this.specs) {
      seen.add(spec.key);
      const y = this.bodyY(spec);
      const point = this.pointFor(spec)(spec.x, y);
      const box = this.clipBox(spec);
      if (box) usedClips.add(`${spec.space ?? 'page'}|${spec.clip!.top}|${spec.clip!.bottom}`);
      const fontSize = Math.max(1, spec.style.size * point.scale);
      const anchorX = spec.style.anchorX ?? 0, anchorY = spec.style.anchorY ?? 0;
      const color = spec.style.color ?? '#f3deb0';
      const align = spec.style.align ?? 'left';
      const contrastBackground = !!spec.style.contrastBackground;
      const styleKey = `${fontSize.toFixed(2)}|${color}|${contrastBackground}|${anchorX}|${anchorY}|${align}`;
      const wrapping = this.wrappingOf(spec.style, point.scale);
      let entry = this.entries.get(spec.key);
      if (!entry) {
        const label = this.newLabel('dom-menu-text', { x: anchorX, y: anchorY });
        // 先隐藏；下面按可视结果统一决定，新建标签就不会闪一帧。
        label.setVisible(false);
        entry = { label, text: '', styleKey: '', wrapKey: '', clipKey: '', x: NaN, y: NaN, visible: false };
        this.entries.set(spec.key, entry);
      }
      // 裁剪窗口内的标签挂进容器，浏览器负责把越出窗口的部分裁掉；切回普通页时再挂回顶层。
      const parent = box?.label.element ?? this.baseLayer;
      if (parent && typeof parent.appendChild === 'function'
        && entry.label.element.parentElement !== parent) parent.appendChild(entry.label.element);
      if (entry.text !== spec.text) {
        entry.text = spec.text;
        entry.label.setText(spec.text);
      }
      if (entry.styleKey !== styleKey) {
        entry.styleKey = styleKey;
        entry.label.setAnchor(anchorX, anchorY);
        entry.label.setStyle({ fontSize: `${fontSize.toFixed(2)}px`, color, textAlign: align, pointerEvents: 'none',
          background: contrastBackground ? CONTRAST_TEXT_BACKGROUND : '', padding: contrastBackground ? '0 3px' : '',
          borderRadius: contrastBackground ? '3px' : '' });
      }
      if (entry.wrapKey !== wrapping.key) {
        entry.wrapKey = wrapping.key;
        entry.label.setStyle(wrapping.css);
      }
      // 页面文字在弹层打开时整体压暗；被弹层矩形盖住的那一段裁掉，不删除整条标签。
      const occlusion = this.occlusionClip(spec, y, point.scale);
      const clipKey = `${spec.dim ? 1 : 0}|${occlusion.key}`;
      if (entry.clipKey !== clipKey) {
        entry.clipKey = clipKey;
        entry.label.setStyle({ opacity: spec.dim ? DIMMED_TEXT_OPACITY : '', clipPath: occlusion.css });
      }
      const x = point.x, top = point.y - (box?.top ?? 0);
      if (entry.x !== x || entry.y !== top) {
        entry.x = x;
        entry.y = top;
        entry.label.setPosition(x, top);
      }
      const visible = occlusion.visible && this.withinClip(spec, y);
      if (entry.visible !== visible) {
        entry.visible = visible;
        entry.label.setVisible(this.shown && visible);
      }
    }
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue;
      entry.label.remove();
      this.entries.delete(key);
    }
    for (const [key, clip] of this.clips) {
      if (usedClips.has(key)) continue;
      clip.label.remove();
      this.clips.delete(key);
    }
  }
}
