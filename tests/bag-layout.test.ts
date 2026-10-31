import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bagLayout, DESCRIPTION_PANEL, descriptionPanel } from '../src/ui/bag-layout.ts';
import { EQUIPMENT_SLOT_ORDER } from '../src/domain/items.ts';

const menuPanels = JSON.parse(fs.readFileSync(
  new URL('../public/content/menu-panels.json', import.meta.url), 'utf8')) as {
    assets:Record<string, string>;
    equipmentSlots:{ id:string; name:string; x:number; y:number }[];
  };

test('bag layout keeps the native panel and grid geometry', () => {
  const layout = bagLayout();
  assert.deepEqual(layout.leftFrame, { x:85, y:0, width:409, height:431 });
  assert.deepEqual(layout.bagFrame, { x:496, y:0, width:395, height:431 });
  assert.deepEqual(layout.preview, { x:214, y:110, width:157, height:157 });
  // 网格：右框内 (34,27)，16 格按 0x53 步长铺四列四行。
  assert.deepEqual(layout.grid, { x:530, y:27, width:323, height:323, stride:83, columns:4 });
  assert.equal(layout.grid.stride, 0x53);
  assert.equal(layout.grid.columns, 4);
  // 末列末行的格子必须正好收在网格区内：530+3×83+74 = 530+323。
  assert.equal(layout.grid.x + (layout.grid.columns - 1) * layout.grid.stride + layout.slot.size,
    layout.grid.x + layout.grid.width);
  assert.equal(layout.grid.y + 3 * layout.grid.stride + layout.slot.size, layout.grid.y + layout.grid.height);
});

test('bag slots draw at the native icon and selection offsets', () => {
  const { slot } = bagLayout();
  assert.deepEqual(slot, { size:74, icon:{ x:5, y:5, size:64 }, selection:{ x:-5, y:-5, size:84 } });
  for (const key of ['inventory-slot', 'inventory-selected']) {
    const png = fs.readFileSync(new URL(`../public/${menuPanels.assets[key]}`, import.meta.url));
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.deepEqual([width, height], key === 'inventory-slot' ? [74, 74] : [84, 84], `${key} 原尺寸`);
  }
});

test('bag side buttons and money follow the native coordinates', () => {
  const layout = bagLayout();
  // 按钮组是右框子控件，组内 x=389；6 个按钮 57×57，组内 y 偏移读自 0x149d38 起的六次建表。
  assert.deepEqual(layout.sideButtons, { x:layout.bagFrame.x + 389, y:layout.bagFrame.y + 12,
    width:57, height:57, offsets:[0, 0x46, 0x8b, 0xd0, 0x115, 0x15b] });
  assert.equal(layout.sideButtons.offsets.length, 6);
  assert.deepEqual(layout.sideButtons.offsets, [0, 70, 139, 208, 277, 347]);
  // 文字底板在右框内 (34,368) 宽 323，金额在同一列、上移 3 像素。
  assert.deepEqual(layout.money, { x:530, y:365, plate:{ x:530, y:368, width:323, height:34 },
    stride:103, coin:{ width:44, height:40 }, digit:{ x:44, y:6 }, color:'#ffffff' });
  assert.equal(layout.money.plate.y - layout.money.y, 3);
  // 数量角标按 ITEM_DrawPorting 画在 (+67,+47)，白色右对齐。
  assert.deepEqual(layout.badge, { x:67, y:47, color:'#ffffff' });
});

test('description panel keeps the native panel, scroll, close and menu rects', () => {
  const { leftFrame, bagFrame } = bagLayout(), description = DESCRIPTION_PANEL;
  // 面板矩形是原版常量：宽 442（建面板时的硬常量），高 431（与内容栏同高，纵向图框素材
  // 24×383 = 431−48 反证）。原版把它放在 y=133，而 133 正是内容框顶边，所以本作等于 0，
  // 不需要任何纵向适配。
  assert.equal(description.width, 442);
  assert.equal(description.height, leftFrame.height);
  assert.equal(description.y, 0);
  assert.deepEqual([leftFrame.x, bagFrame.x], [85, 496], '物品停在左栏，身上装备停在右栏');
  // 面板自带底色：内缩 10 取原版（UIDesc_Draw 里 GRPX_FillRectAlpha 的参数 0x3c=60），
  // 不透明度本作提到 85%——面板要压得住底下那一栏的格子与图标。
  assert.deepEqual([description.inset, description.background, description.backgroundAlpha], [10, 0x000000, .85]);
  // 面板内部件都相对面板左上角：物品名、正文滚动区、右上角关闭按钮、底部菜单行。
  // 物品名不在滚动区里：UIDesc_Draw 把它画在 (20,22)，右边留 82 给关闭按钮。
  assert.deepEqual(description.title, { x:20, y:22, right:82, size:24 });
  assert.deepEqual(description.scroll, { x:20, y:60, width:358, height:258 });
  // 原版落点 349（离右边缘 26），本作右移到 381：圆钮与顶边一样探出面板边缘 6 像素。
  assert.deepEqual(description.close, { x:381, y:-6, size:67 });
  assert.deepEqual([description.menu.x, description.menu.y, description.menu.width, description.menu.height],
    [15, 362, 377, 55]);
  // 菜单按钮一横排：宽 125、高 55、步长 126，起始偏移按数量取 126/64/0，三个恰好铺满 377。
  assert.deepEqual(description.menu.button, { width:125, height:55, stride:126 });
  assert.deepEqual(description.menu.offsets, { 1:126, 2:64, 3:0 });
  assert.equal(description.menu.offsets[3] + 2 * description.menu.button.stride + description.menu.button.width,
    description.menu.width);
  // 面板原点就是点选来源那一栏的左边——85 与 496 分别等于左右框的 x。
  assert.deepEqual([leftFrame.x, bagFrame.x], [85, 496]);
  // 正文滚动区与底部菜单行都收在面板矩形内；面板比单栏宽，因为它本来就盖住本栏并压过右侧间隙。
  for (const part of [
    { x:description.scroll.x, y:description.scroll.y, width:description.scroll.width, height:description.scroll.height },
    { x:description.menu.x, y:description.menu.y, width:description.menu.width, height:description.menu.height },
  ]) {
    assert.ok(part.x >= 0 && part.x + part.width <= description.width, '件横向收在面板内');
    assert.ok(part.y + part.height <= description.height, '件纵向收在面板内');
  }
  // 关闭钮反过来：它挂在右上角，上、右各探出面板 6 像素（`descriptionPanel` 也按这个差值平移）。
  assert.deepEqual([description.close.y, description.close.x + description.close.size - description.width], [-6, 6],
    '关闭钮探出面板上、右各 6 像素');
  for (const width of [395, 409, 442, 462]) {
    const panel = descriptionPanel(width);
    assert.equal(panel.close.x + panel.close.size - panel.width, 6, `${width} 宽的面板关闭钮都探出右边缘 6`);
  }
  assert.ok(description.width > bagFrame.width, '面板比右栏宽，关闭按钮正好落在右上角');
  // 正文与操作行必须落在内容区 0..431 内。缺这条校验时，面板曾被摆到 133 起、底部掉出菜单 82 像素。
  for (const part of [
    { name:'滚动区', y:description.y + description.scroll.y, height:description.scroll.height },
    { name:'操作行', y:description.y + description.menu.y, height:description.menu.height },
  ]) {
    assert.ok(part.y >= 0, `${part.name}不出内容区上沿`);
    assert.ok(part.y + part.height <= leftFrame.height, `${part.name}不出内容区下沿`);
  }
  // 关闭按钮是骑在右上角的做法：上、右各探出面板 6 像素，这是有意的，
  // 所以它允许越过内容区上沿与面板右缘；上面两条只约束正文与操作行。
  assert.equal(description.y + description.close.y, -6);
  assert.equal(description.close.x + description.close.size, description.width + 6, '关闭按钮右缘探出面板右缘 6 像素');
});

test('equipment slots stay in the native display order', () => {
  // 原版按表 0xbbad6 把界面位置映射到装备编号 [0,7,8,9,3,2,5,6,1,4]，
  // 界面次序不是槽位枚举次序，所以这份次序必须显式固定。
  assert.deepEqual([...EQUIPMENT_SLOT_ORDER],
    ['head', 'neck', 'ring', 'accessory', 'body', 'back', 'main-hand', 'off-hand', 'hands', 'feet']);
  assert.deepEqual(menuPanels.equipmentSlots.map(slot => slot.id), [...EQUIPMENT_SLOT_ORDER],
    '内容里的装备槽必须与界面次序一致');
  for (const slot of menuPanels.equipmentSlots) {
    assert.ok(Number.isInteger(slot.x) && Number.isInteger(slot.y), `${slot.id} 坐标`);
  }
});
