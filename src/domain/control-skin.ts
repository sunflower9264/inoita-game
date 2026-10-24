/** 两种游戏模式共用的触屏控件素材；路径同时作为 Phaser 纹理键。 */
export const CONTROL_PARTS = ['stick-base', 'button', 'button-pressed', 'slot-shadow', 'slot-ring',
  'slot-pressed', 'quantity-badge', 'swap', 'swap-pressed', 'skip', 'skip-pressed'] as const;
export type ControlSkin = Record<typeof CONTROL_PARTS[number], string>;
