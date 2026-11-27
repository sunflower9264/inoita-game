/**
 * 全游戏共用的字体栈。
 *
 * 单独成一个不依赖任何上层 UI 模块的基础文件，供领域说明、DOM 控件与渲染提示共同引用，避免反向耦合。
 *
 * 宋体优先，其次思源宋体（Linux 上更常见），再退到 SimSun 与通用衬线。
 */
export const FONT = '"Songti SC", "Noto Serif CJK SC", SimSun, serif';

/**
 * 界面里反复出现的文字颜色，按用途取名。
 *
 * 只收敛语义明确、多处复用的颜色；一次性或同值不同含义的颜色仍写在各自面板里。
 */
export const TEXT_COLORS = {
  /** 原版米色正文与区域文字。 */
  primary: '#e2cb9e',
  /** 次要说明、价格与辅助信息。 */
  secondary: '#c8b78f',
  /** 纯白正文。 */
  white: '#ffffff',
  /** 失败、不可用等警示文字。 */
  danger: '#ff6b6b',
  /** 较柔和的错误与阵亡提示。 */
  dangerSoft: '#e6a191',
  /** 操作成功、云存档已同步等正向提示。 */
  success: '#8fd18a',
  /** 弱化、未鉴定或占位文字。 */
  muted: '#808080',
  /** 条件或点数不满足时的要求文字。 */
  requirementUnmet: '#ff0000',
  /** 宝石词条。 */
  gemModifier: '#bf0000'
} as const;
