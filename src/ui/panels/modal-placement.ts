import type { MenuTextOcclude, MenuTextPoint, MenuTextSpec } from '../dom/menu-text.ts';
import type { UiSurface } from '../widgets.ts';
import { frameRect } from '../viewport.ts';

/** 面板声明弹层外框的参考尺寸，由菜单统一保存并在重绘、缩放时定位。 */
export type PlaceModal = (width:number, height:number) => void;

/** 菜单画布与全屏弹层共用的参考尺寸；页面内容块 960×431 居中在它里面。 */
export const MENU_CANVAS_WIDTH = 1024;
export const MENU_CANVAS_HEIGHT = 640;
/** 菜单里带整块图框的确认弹层：队伍详情、能力加点和技能重置共用。 */
export const MENU_FRAME_MODAL_WIDTH = 718;
export const MENU_FRAME_MODAL_HEIGHT = 415;

/**
 * 弹层画布按自己的内容尺寸在父画布里居中。宽度与高度是内容实际占用的外框，由各对话框按
 * 自己画的框给出——锚点因此不再依赖写死的坐标，改某个对话框的尺寸也不会让别的对话框跑偏。
 * 对话框都从框左上角开始画，所以移动根节点就等于移动那个左上角。
 *
 * 根节点尺寸与本次弹层的内容尺寸同步。
 */
export function centerModal(modal: UiSurface, parent: UiSurface, width: number, height: number): void {
  const matrix = parent.root.getWorldTransformMatrix();
  const position = matrix.transformPoint((parent.width - width) / 2, (parent.height - height) / 2);
  modal.root.setSize(width,height).setPosition(position.x, position.y).setScale(matrix.scaleX, matrix.scaleY);
}

/** 表面局部坐标换算到画框 CSS 坐标和缩放倍率，供 DOM 文字定位共用。 */
export function surfaceScreenPoint(surface: Pick<UiSurface, 'root'>, x: number, y: number): MenuTextPoint {
  const matrix = surface.root.getWorldTransformMatrix();
  const point = matrix.transformPoint(x, y);
  return { x: point.x, y: point.y, scale: matrix.scaleX };
}

/** 将源表面（如 `modal`）的局部坐标换算到目标表面（如 `body` 或 `surface`）坐标系。 */
export function surfacePointToTarget(
  source: Pick<UiSurface, 'root'>,
  target: Pick<UiSurface, 'root'>,
  x: number,
  y: number,
): { x: number; y: number } {
  const world = source.root.getWorldTransformMatrix().transformPoint(x, y);
  const targetMatrix = target.root.getWorldTransformMatrix();
  const origin = targetMatrix.transformPoint(0, 0);
  return { x: (world.x - origin.x) / (targetMatrix.scaleX || 1), y: (world.y - origin.y) / (targetMatrix.scaleY || 1) };
}

/** 弹层矩形在目标表面坐标里的遮挡区域；`pad` 用于把外框边沿一并让出。 */
export function modalOcclusionRect(
  modal: Pick<UiSurface, 'root'>,
  target: Pick<UiSurface, 'root'>,
  width: number,
  height: number,
  pad = 0,
): MenuTextOcclude {
  const start = surfacePointToTarget(modal, target, 0, 0);
  const end = surfacePointToTarget(modal, target, width, height);
  return { left: start.x - pad, top: start.y - pad, right: end.x + pad, bottom: end.y + pad };
}

/** 原生提示横带（含上下装饰边距 `edge`）在目标表面坐标里的遮挡矩形。 */
export function bandOcclusionRect(
  modal: Pick<UiSurface, 'root'>,
  target: Pick<UiSurface, 'root'>,
  band: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  edge: number,
): MenuTextOcclude {
  const start = surfacePointToTarget(modal, target, band.left, band.top - edge);
  const end = surfacePointToTarget(modal, target, band.left + band.width, band.top + band.height + edge);
  return { left: start.x, top: start.y, right: end.x, bottom: end.y };
}

/** 弹层文字规格及其滚动裁剪区间统一换算到目标表面坐标系。 */
export function transformModalTextSpec(
  spec: MenuTextSpec,
  modal: Pick<UiSurface, 'root'>,
  target: Pick<UiSurface, 'root'>,
): MenuTextSpec {
  const point = surfacePointToTarget(modal, target, spec.x, spec.y);
  const clip = spec.clip
    ? {
        top: surfacePointToTarget(modal, target, 0, spec.clip.top).y,
        bottom: surfacePointToTarget(modal, target, 0, spec.clip.bottom).y,
      }
    : undefined;
  return { ...spec, x: point.x, y: point.y, clip };
}

/**
 * 屏幕在 surface 本地坐标里覆盖的范围。surface 会按设备安全区和留白缩放、居中，
 * 直接按 `surface.width` 画的横带会在屏幕两侧留下空隙；需要铺满整屏时用这里的范围。
 * 原点取 surface 根节点的实际屏幕位置，安全区左右不相等时横带也不会偏出屏幕。
 */
export function screenCoverage(surface: UiSurface):{left:number;top:number;width:number;height:number} {
  const matrix = surface.root.getWorldTransformMatrix(), frame = frameRect();
  const scaleX = matrix.scaleX || 1, scaleY = matrix.scaleY || 1;
  const origin = matrix.transformPoint(0, 0);
  // 按页面根节点的实际屏幕原点反算，菜单在安全区内居中时也不受左右安全区不对称影响。
  return {left:-origin.x / scaleX, top:-origin.y / scaleY,
    width:frame.width / scaleX, height:frame.height / scaleY};
}
