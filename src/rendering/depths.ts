/**
 * 世界层的固定深度偏移。
 *
 * 这里只放数字，不 import Phaser：移动相关的测试会直接加载移动模块，不需要为了
 * 一个深度常量把整套角色渲染和 Phaser 混合模式一起拉进来。
 */

/** 人物容器按脚点 y 排序，再加 0.5，保证与脚下特效、选中圈的层次稳定。 */
export const CHARACTER_FOOT_DEPTH_OFFSET = 0.5;

/** 特效容器的深度取世界 y 加 1，画在同脚点的人物（y + 0.5）之上。 */
export const EFFECT_DEPTH_OFFSET = 1;
