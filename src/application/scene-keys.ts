/**
 * 场景键的唯一名字。
 *
 * 注册（各场景的 `super(...)`）、查找（`getScene`／`get`）与启动（`scene.start`／`launch`）
 * 原先各写一份裸字符串，编译器从不参与校验。名字失配的表现是「某个面板不出现」或某处
 * 静默没有反应，而不是报错。
 *
 * 放在 `application/` 是因为它要同时被 `scenes/`、`rendering/` 与 `ui/` 引用，
 * 而这三层都允许依赖 `application/`；反向从 `scenes/` 取名字会把 Phaser 与整棵场景树
 * 一起拉进渲染层。
 */
export const SCENE_KEYS = {
  textureLoader: 'texture-loader',
  menu: 'menu',
  classSelect: 'story-class-select',
  world: 'world',
  storyStage: 'story-stage',
  formalUi: 'formal-ui',
  audio: 'audio',
} as const;
