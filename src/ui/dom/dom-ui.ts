import type Phaser from 'phaser';
import { FONT } from '../text-style.ts';
import { UI_UNIT_HEIGHT, UI_UNIT_WIDTH } from '../viewport.ts';

type DomLayerName = 'world' | 'hud' | 'screen' | 'overlay';

/** 一个 DOM 文字节点；只改内容、位置和显隐，不参与 Phaser 渲染。 */
export interface DomLabel {
  readonly element: HTMLDivElement;
  setText(text: string): DomLabel;
  setPosition(x: number, y: number): DomLabel;
  setAnchor(x: number, y: number): DomLabel;
  setVisible(visible: boolean): DomLabel;
  setClassName(className: string): DomLabel;
  setStyle(style: Partial<CSSStyleDeclaration>): DomLabel;
  remove(): void;
}

interface DomPoint { x: number; y: number }
interface WorldMeasurements {
  frame: HTMLElement;
  canvas: HTMLCanvasElement;
  game: Phaser.Game;
  frameNumber: number;
  frameRect: DOMRect;
  canvasRect: DOMRect;
}

/**
 * 画布上方的 DOM 文字层。
 *
 * 屏幕文字直接使用画框内的 CSS 坐标；世界文字由 `worldToScreen()` 用相机
 * `worldView`、`zoom` 和画布显示尺寸投影。根节点延迟到第一次
 * `attach()` 才创建，Node 测试环境可以只导入类型和纯函数，不会碰 `document`。
 */
export class DomUi {
  private root?: HTMLDivElement;
  private frame?: HTMLElement;
  private worldMeasurements?: WorldMeasurements;
  private readonly layers = new Map<DomLayerName, HTMLDivElement>();
  private readonly visible = new Map<DomLayerName, boolean>();
  /** 全屏遮罩出现时统一收起普通文字层；overlay 层不受影响。 */
  private occluded = false;

  /** 幂等：重复调用不会创建第二个根节点。 */
  attach(): void {
    if (typeof document === 'undefined') return;
    if (this.root?.isConnected) return;
    const frame = document.getElementById('game-frame');
    if (!frame) return;
    this.frame = frame;
    const root = document.createElement('div');
    root.id = 'ui-root';
    root.style.setProperty('--font-game', FONT);
    for (const name of ['world', 'hud', 'screen', 'overlay'] as const) {
      const layer = document.createElement('div');
      layer.id = `ui-${name}`;
      layer.className = 'dom-ui-layer';
      root.appendChild(layer);
      this.layers.set(name, layer);
      this.visible.set(name, true);
    }
    // Phaser 默认还会在 window 上处理画布外的 mousedown/touchstart；HUD 控件是 DOM，
    // 在这里截住冒泡，点按钮、摇杆和控件之间的空隙才不会再命中背后的地图对象。
    const hudLayer = this.layers.get('hud');
    if (hudLayer) for (const name of ['pointerdown', 'mousedown', 'touchstart'])
      hudLayer.addEventListener(name, event => event.stopPropagation());
    frame.appendChild(root);
    this.root = root;
    this.layout();
    // attach 之前设置的遮挡状态在这里补应用；正常情况下四层都先按原可见性还原。
    for (const name of this.layers.keys()) this.applyLayer(name);
  }

  get attached(): boolean { return !!this.root?.isConnected; }

  layer(name: DomLayerName): HTMLDivElement | undefined {
    this.attach();
    return this.layers.get(name);
  }

  label(name: DomLayerName, className = 'dom-label', anchor: DomPoint = { x: 0, y: 0 }): DomLabel {
    const parent = this.layer(name);
    const element = document.createElement('div');
    // 定位与换行规则统一由 `dom-label` 提供；调用方只补自己的样式类。
    const classes = className.split(/\s+/).filter(Boolean);
    if (!classes.includes('dom-label')) classes.unshift('dom-label');
    element.className = classes.join(' ');
    let x = 0, y = 0;
    let anchorX = anchor.x, anchorY = anchor.y, shown = this.visible.get(name) !== false;
    element.hidden = !shown;
    const applyAnchor = () => {
      element.style.transformOrigin = `${anchorX * 100}% ${anchorY * 100}%`;
      element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(${-anchorX * 100}%, ${-anchorY * 100}%)`;
    };
    applyAnchor();
    parent?.appendChild(element);
    const label: DomLabel = {
      element,
      setText(text: string): DomLabel {
        if (element.textContent !== text) element.textContent = text;
        return label;
      },
      setPosition(nextX: number, nextY: number): DomLabel {
        x = nextX; y = nextY; applyAnchor();
        return label;
      },
      setAnchor(x: number, y: number): DomLabel {
        anchorX = x; anchorY = y; applyAnchor();
        return label;
      },
      setVisible(visible: boolean): DomLabel {
        if (shown === visible) return label;
        shown = visible;
        element.hidden = !visible;
        return label;
      },
      setClassName(className: string): DomLabel {
        const classes = className.split(/\s+/).filter(Boolean);
        if (!classes.includes('dom-label')) classes.unshift('dom-label');
        const name = classes.join(' ');
        if (element.className !== name) element.className = name;
        return label;
      },
      setStyle(style: Partial<CSSStyleDeclaration>): DomLabel {
        Object.assign(element.style, style);
        return label;
      },
      remove(): void {
        element.remove();
      }
    };
    return label;
  }

  setLayerVisible(name: DomLayerName, visible: boolean): void {
    if (!this.attached) return;
    if (this.visible.get(name) === visible) return;
    this.visible.set(name, visible);
    this.applyLayer(name);
  }

  /**
   * 全屏遮罩（加载页、阵亡面板、跨图黑幕、横屏提示）出现时收起普通文字层。
   * 只改四个层的 `hidden`，不遍历标签；恢复时按各层原来的可见性还原。
   */
  setOccluded(value: boolean): void {
    if (this.occluded === value) return;
    // 先记状态：attach 之前调用也要在 attach 后生效。
    this.occluded = value;
    if (typeof document !== 'undefined') document.body.classList.toggle('ui-occluded', value);
    if (!this.attached) return;
    for (const name of this.layers.keys()) this.applyLayer(name);
  }

  private applyLayer(name: DomLayerName): void {
    const layer = this.layers.get(name);
    if (!layer) return;
    layer.hidden = this.visible.get(name) === false || (this.occluded && name !== 'overlay');
  }

  /** 重新读取画框与安全区；只在视口变化和字体就绪后调用。 */
  layout(): void {
    this.worldMeasurements = undefined;
    if (typeof document === 'undefined') return;
    const frame = this.frame ?? document.getElementById('game-frame');
    if (!frame) return;
    this.frame = frame;
  }

  /** 当前画框的 CSS 尺寸；DOM 文字用它换算字号和位置。 */
  frameSize(camera?: Phaser.Cameras.Scene2D.Camera): { width: number; height: number } {
    const measurements = camera && this.measureWorld(camera);
    if (measurements) return { width: measurements.frameRect.width, height: measurements.frameRect.height };
    if (typeof document === 'undefined') return { width: 0, height: 0 };
    const frame = this.frame ?? document.getElementById('game-frame');
    if (!frame) return { width: 0, height: 0 };
    const rect = frame.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /** 界面单位：800×480 基准，与现有 `uiUnitScale` 同一口径。 */
  storyUnit(camera?: Phaser.Cameras.Scene2D.Camera): number {
    const { width, height } = this.frameSize(camera);
    return Math.min(width / UI_UNIT_WIDTH, height / UI_UNIT_HEIGHT);
  }

  /**
   * 世界坐标 → 画框内 CSS 坐标。
   * 必须在相机 `preRender` 之后读取，否则会用到上一帧的 `worldView`。
   */
  private measureWorld(camera: Phaser.Cameras.Scene2D.Camera): WorldMeasurements | undefined {
    const frame = this.frame ?? (typeof document === 'undefined' ? undefined : document.getElementById('game-frame'));
    const game = camera.scene?.game, canvas = game?.canvas;
    if (!frame || !game || !canvas) return undefined;
    const frameNumber = game.loop?.frame;
    const previous = this.worldMeasurements;
    if (frameNumber !== undefined && previous?.frameNumber === frameNumber && previous.game === game &&
      previous.frame === frame && previous.canvas === canvas) return previous;
    const measurements = { frame, canvas, game, frameNumber, frameRect: frame.getBoundingClientRect(),
      canvasRect: canvas.getBoundingClientRect() };
    if (frameNumber !== undefined) this.worldMeasurements = measurements;
    return measurements;
  }

  worldToScreen(camera: Phaser.Cameras.Scene2D.Camera, x: number, y: number): DomPoint {
    const measurements = this.measureWorld(camera);
    if (!measurements) return { x: 0, y: 0 };
    const { frameRect, canvasRect } = measurements;
    const scaleX = canvasRect.width / Math.max(1, camera.scene.scale.width);
    const scaleY = canvasRect.height / Math.max(1, camera.scene.scale.height);
    return {
      x: canvasRect.left - frameRect.left + (x - camera.worldView.x) * camera.zoom * scaleX,
      y: canvasRect.top - frameRect.top + (y - camera.worldView.y) * camera.zoom * scaleY
    };
  }

}
