// 由 npm run atlas:ui 生成，勿手改。
export interface UiAtlasPage { key: string; file: string; data: string; frame: string; width: number; height: number; group: string }
export const UI_ATLAS_PAGES: readonly UiAtlasPage[] = ([
  ["assets/ui/shop/category-divider.png",2047,1720,"menu/core"],
  ["assets/ui/story/portrait-alexander-057.png",1538,1744,"story/portraits"],
  ["assets/ui/story/portrait-red-dragon.png",1538,1024,"story/portraits"],
  ["assets/ui/story-classes/panel-left.png",1975,248,"story/portraits"],
  ["assets/ui/status/player-portrait-down.png",2048,275,"hud/status/minimap"],
  ["assets/ui/menus/edge-vertical.png",1828,415,"title"]
] as readonly (readonly [string, number, number, string])[]).map((row, i) => ({ key: `interface:assets/ui/menu-ui-${i}.webp`, file: `assets/ui/menu-ui-${i}.webp`, data: `assets/ui/menu-ui-${i}.json`, frame: row[0], width: row[1], height: row[2], group: row[3] }));
const eachRow = (groups: readonly string[], visit: (file: string, fields: string[]) => void): void => {
  for (const group of groups) {
    const [dir, ...rows] = group.split('|');
    for (const row of rows) {
      const [name, ...fields] = row.split(',');
      visit(`${dir}/${name}.png`, fields);
    }
  }
};
// 每行：目录|名字,页号[,帧名]；省略帧名时帧名就是文件路径，纹理键取该页的 key
const FRAME_ROWS: readonly string[] = [
  "assets/characters/battle-assassin|preview,0",
  "assets/characters/battle-dark-knight|preview,0",
  "assets/characters/battle-lancer|preview,0",
  "assets/characters/battle-priest|preview,0",
  "assets/characters/battle-ranger|preview,0",
  "assets/characters/battle-warlock|preview,0",
  "assets/characters/battle-warrior|preview,0",
  "assets/ui/menus|back,0|character-adjust,0|character-azad-053,0|character-experience-end,0|character-experience-fill,0|character-experience-start,0|character-gauge,0|character-health-end,0|character-health-fill,0|character-health-start,0|character-kiyan,0|character-mana-end,0|character-mana-fill,0|character-mana-start,0|character-ne,0|character-nw,0|character-olaf,0|character-party-azad-053,0|character-party-frame,0|character-party-kiyan,0|character-party-olaf,0|character-party-portia,0|character-party-shinty,0|character-portia,0|character-se,0|character-shinty,0|character-step-pressed,0|character-sw,0|class-assassin,0|class-dark-knight,0|class-lancer,0|class-priest,0|class-ranger,0|class-warlock,0|class-warrior,0|column-cap-bottom,0|column-cap-top,0|confirm,0|craft-button-disabled,0|craft-button-pressed,0|craft-button,0|craft-money-copper,0|craft-money-gold,0|craft-money-silver,0|equipment-empty-back,0|equipment-empty-body,0|equipment-empty-feet,0|equipment-empty-hands,0|equipment-empty-head,0|equipment-empty-main-hand,0|equipment-empty-neck,0|equipment-empty-off-hand,0|equipment-empty-ring,0|inventory-selected,0|inventory-slot-chaos,0|inventory-slot-epic-chaos,0|inventory-slot-rarity-1,0|inventory-slot-rarity-2,0|inventory-slot-rarity-3,0|inventory-slot-rarity-4,0|inventory-slot,0|item-discard,0|item-equip,0|item-unequip,0|item-use,0|menu-back-pressed,0|menu-back,0|page-button-frame,0|page-button-selected,0|party-button-pressed,0|party-class-assassin,0|party-class-dark-knight,0|party-class-lancer,0|party-class-priest,0|party-class-ranger,0|party-class-warlock,0|party-class-warrior,0|party-deployed,0|party-dismiss,0|party-empty,0|party-frame,0|party-join,0|party-page-1,0|party-page-2,0|party-reserve,0|party-selected,0|party-slot,0|party-tab-equipment,0|party-tab-info,0|popup-corner-ne,0|popup-corner-nw,0|popup-corner-se,0|popup-corner-sw,0|popup-edge-horizontal,0|popup-edge-vertical,0|quest-main,0|quest-ready,0|quest-row-pressed,0|quest-row-selected,0|quest-row,0|round-ne,0|round-nw,0|round-se,0|round-sw,0|skill-button-pressed,0|skill-compare-arrow,0|skill-confirm,0|skill-learn,0|skill-level-high,0|skill-level-none,0|skill-level-normal,0|skill-level-pressed,0|skill-locked,0|skill-rank-1,0|skill-rank-2,0|skill-rank-3,0|skill-rank-4,0|skill-rank-5,0|skill-rank-6,0|skill-rank-7,0|skill-rank-8,0|skill-rank,0|skill-selected-ai,0|skill-selected,0|skill-shortcut-cancel,0|skill-shortcut,0|skill-slot,0|skill-tab-ai,0|skill-tab-directory,0|skill-tab-settings,0|solid-edge,0|solid-ne,0|solid-nw,0|solid-se,0|solid-sw,0|text-plate-left,0|text-plate-right,0",
  "assets/ui/shop|axe-selected,0|axe,0|boots-selected,0|boots,0|bow-selected,0|bow,0|category-cap-bottom,0|category-cap-top,0|category-divider,0|circlet-selected,0|circlet,0|cloth-selected,0|cloth,0|count-right-pressed,0|count-right,0|crossbow-selected,0|crossbow,0|dagger-selected,0|dagger,0|gloves-selected,0|gloves,0|hat-selected,0|hat,0|helmet-selected,0|helmet,0|leather-selected,0|leather,0|longsword-selected,0|longsword,0|mace-selected,0|mace,0|merchant-title,0|orb-selected,0|orb,0|plate-selected,0|plate,0|shield-selected,0|shield,0|staff-selected,0|staff,0|two-handed-selected,0|two-handed,0",
  "assets/ui/story|dialogue-edge,0|menu,0|quest-popup-rule,0|save,0|tab-bag,0|tab-party,0|tab-quests,0|tab-skills,0|tab-status,0|tab-system,0|portrait-alexander-057,1|portrait-azad-053,1|portrait-cornette-199,1|portrait-darius,1|portrait-janus,1|portrait-kiyan,1|portrait-olaf,1|portrait-portia,1|portrait-purple-demon,1|portrait-red-dragon,2|portrait-saint,2|portrait-shinty,2|portrait-veteran-498,2",
  "assets/ui/story-classes|assassin,3|attributes-top,3|dark-knight,3|description-top,3|lancer,3|panel-left,3|panel-right,3|priest,3|ranger,3|selected,3|start-pressed,3|start,3|title,3|warlock,3|warrior,3",
  "assets/ui/minimap|corner-ne,4|corner-nw,4|corner-se,4|corner-sw,4|edge-horizontal,4|edge-vertical,4|exit,4|interact,4|player,4|special,4",
  "assets/ui/status|buff-aimed-shot,4|buff-ambush,4|buff-apostles-of-light,4|buff-armor-penetration,4|buff-bard-of-destruction,4|buff-blade-deflection,4|buff-blood-curse,4|buff-blood-revenge,4|buff-blood-thirst,4|buff-celestial-armor,4|buff-curse-of-screams,4|buff-dark-sense,4|buff-dark-strike,4|buff-deep-breath,4|buff-demon-s-shield,4|buff-dragon-step,4|buff-energy-bodhi,4|buff-enrage,4|buff-focus-edge,4|buff-gale-stance,4|buff-guardian-of-darkness,4|buff-holy-sacrifice,4|buff-light-command,4|buff-magic-insight,4|buff-mana-recovery,4|buff-molten-armor,4|buff-net-shackles,4|buff-ordination-prayer,4|buff-pain-overture,4|buff-phantom-clash,4|buff-poison-touch,4|buff-shield-of-trust,4|buff-shouts-of-threat,4|buff-sniping,4|buff-spell-redemption,4|buff-spirit-of-nature,4|buff-spiritual-blade,4|buff-spring-frenzy,4|buff-spring-health-recovery,4|buff-spring-mana-recovery,4|buff-spring-potion-weakened,4|buff-spring-skill-seal,4|buff-storm-of-frenzy,4|buff-summon-bard,4|buff-survival-instinct,4|buff-weapon-hitback,4|buff-whist,4|experience-end,4|experience-fill,4|experience-start,4|health-end,4|health-fill,4|health-start,4|mana-end,4|mana-fill,4|mana-start,4|member-frame,4|member-portrait-down,4|member-portrait,4|member-shadow,4|player-frame,4|player-portrait-down,4|player-portrait,4|player-shadow,4|target-end,4|target-fill,4|target-frame,4|target-special,4|target-start,4",
  "assets/ui/menus|close-pressed,5|close,5|corner-ne,5|corner-nw,5|corner-se,5|corner-sw,5|edge-horizontal,5|edge-vertical,5",
  "assets/ui/title-menu|back,5|slot-empty,5|slot,5|subtitle-left,5|subtitle-right,5",
  "assets/ui/status|buff-spring-mana-cost,4,assets/ui/status/buff-mana-recovery.png|buff-spring-power-up,4,assets/ui/status/buff-spring-health-recovery.png|buff-storm-of-frenzy-power,4,assets/ui/status/buff-shouts-of-threat.png|buff-spring-potion-sickness,4,assets/ui/status/buff-dark-sense.png",
  "assets/ui/menus|character-step,0,assets/ui/menus/back.png|party-tab-skills,0,assets/ui/menus/skill-tab-directory.png|party-skill-unavailable,0,assets/ui/menus/skill-locked.png|equipment-empty-accessory,0,assets/ui/menus/equipment-empty-ring.png",
  "assets/ui/story|edge-horizontal,5,assets/ui/menus/edge-horizontal.png|edge-vertical,5,assets/ui/menus/edge-vertical.png|corner-nw,5,assets/ui/menus/corner-nw.png|corner-ne,5,assets/ui/menus/corner-ne.png|corner-sw,5,assets/ui/menus/corner-sw.png|corner-se,5,assets/ui/menus/corner-se.png|slot,0,assets/ui/menus/page-button-frame.png|close,5,assets/ui/menus/close.png|confirm,0,assets/ui/menus/confirm.png|back,0,assets/ui/menus/back.png|save-slot,5,assets/ui/title-menu/slot.png|save-empty,5,assets/ui/title-menu/slot-empty.png|money-gold,0,assets/ui/menus/craft-money-gold.png|money-silver,0,assets/ui/menus/craft-money-silver.png|money-copper,0,assets/ui/menus/craft-money-copper.png",
  "assets/ui/shop|slot,0,assets/ui/menus/inventory-slot.png|selection,0,assets/ui/menus/inventory-selected.png|gold,0,assets/ui/menus/craft-money-gold.png|silver,0,assets/ui/menus/craft-money-silver.png|copper,0,assets/ui/menus/craft-money-copper.png|text-plate-left,0,assets/ui/menus/text-plate-left.png|text-plate-right,0,assets/ui/menus/text-plate-right.png|count-left,0,assets/ui/menus/back.png|count-left-pressed,0,assets/ui/menus/character-step-pressed.png"
];
const frames: Record<string, { key: string; frame: string; page: number }> = {};
eachRow(FRAME_ROWS, (file, [page, frame]) => {
  frames[file] = { key: UI_ATLAS_PAGES[Number(page)]!.key, frame: frame ?? file, page: Number(page) };
});
export const UI_ATLAS_FRAMES: Readonly<Record<string, { key: string; frame: string; page: number }>> = frames;
export const UI_ATLAS_SOURCE_DIGEST = "97f27478fee4967e98074399420e6b13c245c0034e119c2b65b8fb434a4e90fd";
