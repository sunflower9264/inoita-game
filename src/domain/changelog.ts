/** 标题页按发布顺序维护的游戏版本及其更新说明。 */
export interface ChangelogRelease {
  gameVersion: string;
  /** 每条是一段正文；空字符串会被内容校验拒绝。 */
  entries: string[];
}

/** 内容集中在 public/content/changelog.json，点按钮时才加载。 */
export interface ChangelogCatalog {
  version: 2;
  /** 按新到旧排列，第一项是默认显示的版本。 */
  releases: ChangelogRelease[];
}
