import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session } from '../src/domain/session.ts';
import { Storefront } from '../src/domain/shop.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { parseShops } from '../src/application/content-validation.ts';
import { BAG_DESCRIPTION_WIDTH, DESCRIPTION_PANEL } from '../src/ui/bag-layout.ts';
import { descriptionPanel, POPUP_FRAME, shopLayout, tradeLayout, tradeMessageLayout } from '../src/ui/shop-layout.ts';
import { INVENTORY_LABELS, INVENTORY_SIDE_FILTERS } from '../src/domain/inventory.ts';
import { splitMoney } from '../src/domain/money.ts';
import { ShopPanel } from '../src/ui/phaser/shop-panel.ts';
import { centerModal } from '../src/ui/phaser/modal-placement.ts';

const read=<T>(name:string):T=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),shops=parseShops(read('shops'));
const campaign=read<Campaign>('campaign');
const item=(name:string)=>Object.values(items.items).find(value=>value.name===name)!;

class Node {
  height=24;label='';origin:{x:number;y:number}={x:0,y:0};children:Node[]=[];text='';color='';
  data:Record<string,unknown>={};alpha=1;interactive=true;
  context={measureText:(text:string)=>({width:Array.from(text).length*12})};
  destroy(){}
  setOrigin(x:number,y?:number){this.origin={x,y:y??x};return this;}
  setData(key:string,value:unknown){this.data[key]=value;if(key==='label')this.label=String(value);return this;}
  getData(key:string){return this.data[key];}
  setAlpha(value:number){this.alpha=value;return this;}
  setInteractive(){this.interactive=true;return this;}
  disableInteractive(){this.interactive=false;return this;}
  setPosition(){return this;}setScale(){return this;}setColor(color:string){this.color=color;return this;}
  setFlipX(){return this;}setFlipY(){return this;}
  setFontSize(){return this;}setVisible(){return this;}setText(value:string){this.text=value;return this;}
  add(child:Node){this.children.push(child);return this;}
}
type Call = Record<string, unknown> & {node?:Node};
/** 只实现 ShopPanel 用到的那几个方法，按调用顺序记下每个绘制指令。UiSurface 新增方法被 ShopPanel 使用时同步补这里。 */
class Surface {
  calls:Call[]=[];visibleCalls=0;width=1024;height=640;
  /** `centerModal` 会把自己的锚点写到这里，据此断言弹层居中。 */
  root={x:0,y:0,scaleX:1,scaleY:1,
    getWorldTransformMatrix(){return {transformPoint:(x:number,y:number)=>({x,y}),scaleX:1,scaleY:1};},
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},
    setScale(scale:number){this.scaleX=scale;return this;}};
  /** 静态层：生产代码按 key 只画一次；测试每次重画都会清空 calls，所以这里直接重放，保证静态图框仍被记录。 */
  staticRoot=new Node();
  staticLayer(_key:string,draw:()=>void){draw();}
  frame(_frames:Record<string,string>,x:number,y:number,width:number,height:number){this.calls.push({kind:'frame',x,y,width,height});}
  /** `frame` 拆出图框之后的单独入口；说明面板用它。 */
  border(_frames:Record<string,string>,x:number,y:number,width:number,height:number){this.calls.push({kind:'border',x,y,width,height});}
  image(file:string,x:number,y:number,width?:number,height?:number){this.calls.push({kind:'image',file,x,y,width,height});return new Node();}
  text(value:string,x:number,y:number,width=0,size=0,color?:string){
    const node=new Node();node.text=value;this.calls.push({kind:'text',value,x,y,width,size,color,node});return node;
  }
  rect(x:number,y:number,width:number,height:number,color:number,alpha:number){this.calls.push({kind:'rect',x,y,width,height,color,alpha});return new Node();}
  textPlate(left:string,right:string,x:number,y:number,width:number){this.calls.push({kind:'textPlate',left,right,x,y,width});}
  button(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:Record<string,unknown>){
    const node=new Node();
    // 真按钮把可用态开关挂在 data 的 `setEnabled` 上，商店的数量箭头靠它就地变灰/恢复。
    const setEnabled=(enabled:boolean)=>{enabled?node.setInteractive():node.disableInteractive();node.setAlpha(enabled?1:.4);};
    node.setData('setEnabled',setEnabled);
    if(options?.disabled)setEnabled(false);
    this.calls.push({kind:'button',label,x,y,width,height,action,options,node});return node;
  }
  scroll(x:number,y:number,width:number,height:number){
    this.calls.push({kind:'scroll',x,y,width,height});
    return {content:new Node(),guard:()=>true,setHeight(){},scrollTop:0};
  }
  visible(){this.visibleCalls++;}
  get images(){return this.calls.filter(call=>call.kind==='image');}
  texts(value:string){return this.calls.filter(call=>call.kind==='text'&&call.value===value);}
  get frames(){return this.calls.filter(call=>call.kind==='frame'&&call.width===450);}
  /**
   * 说明面板自己的图框：宽度随所盖那一栏变（395／409／462 都可能），所以按画法认——
   * `drawDescriptionPanel` 一定是先铺内缩 10 的黑色底（不透明度见 `DESCRIPTION_PANEL`）、紧接着画图框。
   */
  get descriptionBorders(){return this.calls.filter((call,index)=>{
    const before=this.calls[index-1];
    return call.kind==='border'&&!!before&&before.kind==='rect'&&before.color===0&&before.alpha===DESCRIPTION_PANEL.backgroundAlpha;});}
  /** 说明面板的内缩黑底：`GRPX_FillRectAlpha(...,0xff000000,60)` 的矩形。 */
  get descriptionFills(){return this.calls.filter(call=>call.kind==='rect'&&call.color===0&&call.alpha===DESCRIPTION_PANEL.backgroundAlpha);}
  /** 面板上不画字的按钮（关闭钮）用 `setData('label')` 标身份，所以两种标签都要认。 */
  get buttons(){return this.calls.filter(call=>call.kind==='button'&&(call.label!==''||call.node?.label));}
}

const open=(id:string,changed:()=>void=()=>{})=>{
  const session=new Session(campaign,undefined,undefined,items);
  const store=new Storefront(shops,items,stats,session,id,'shadow-camp',()=>0.1),surface=new Surface();
  // 商店面板拿到的图组资产清单；弹层的图框与背包那列按钮都从这里取图。
  const frames=Object.fromEntries(['popup-corner-nw','popup-corner-ne','popup-corner-sw','popup-corner-se',
    'popup-edge-horizontal','popup-edge-vertical','page-button-frame','page-button-selected',
    'column-cap-top','column-cap-bottom','close','close-pressed']
    .map(key=>[key,`assets/ui/menus/${key}.png`]));
  const panel=new ShopPanel(store,session,shops,frames,changed);
  const parent=new Surface();
  // 说明面板画在单独一层上：停在右栏时它压在背包格子上，画在内容块里会被格子的图层盖住。
  const description=new Surface();
  const draw=()=>{surface.calls=[];description.calls=[];panel.render(surface as never,surface as never,(width,height)=>centerModal(surface as never,parent as never,width,height),description as never);};
  draw();
  return {store,session,surface,description,panel,draw};
};
/** 货架格与背包格是 bare 按钮，标签由 setData('label') 给出。 */
const press=(surface:Surface,label:string)=>{
  const call=surface.calls.find(call=>call.kind==='button'&&String(call.node?.label??'').startsWith(label));
  assert.ok(call,`未找到按钮 ${label}`);(call.action as ()=>void)();
};
const boxButton=(surface:Surface,label:string)=>surface.buttons.find(call=>String(call.node?.label||call.label)===label)!;
/** 弹层图框画的四角与四条边，坐标相对框的左上角（翅角与边都会画到框外）。 */
const popupFrame=(surface:Surface)=>surface.calls.filter(call=>call.kind==='image'&&/popup-(corner|edge)/.test(String(call.file)))
  .map(call=>[String(call.file).split('/').pop(),call.x,call.y,call.width,call.height]);
/** 原版弹层图框的落点：四角 81×81、横条 (35,−46) 与 (35,高+45−81)、竖条 (−46,35) 与 (宽+45−81,35)。 */
const nativePopupFrame=(width:number,height:number)=>[
  ['popup-corner-nw.png',-46,-46,81,81],['popup-corner-ne.png',width-35,-46,81,81],
  ['popup-corner-sw.png',-46,height-35,81,81],['popup-corner-se.png',width-35,height-35,81,81],
  ['popup-edge-horizontal.png',35,-46,width-70,81],['popup-edge-horizontal.png',35,height-36,width-70,81],
  ['popup-edge-vertical.png',-46,35,81,height-70],['popup-edge-vertical.png',width-36,35,81,height-70],
];

test('shop layout keeps the native panel geometry',()=>{
  const general=shopLayout(false),classified=shopLayout(true);
  assert.deepEqual(general.leftFrame,{x:85,y:0,width:395,height:431});
  assert.deepEqual(classified.leftFrame,{x:18,y:0,width:462,height:431});
  assert.deepEqual(general.bagFrame,{x:484,y:0,width:395,height:431});
  assert.deepEqual(general.shelf,{x:121,y:80});assert.deepEqual(classified.shelf,{x:135,y:86});
  // 标题框：一般商店居中于左框，分类页固定 +131；名称中心落在标题框中线。
  assert.deepEqual(general.title,{x:138,y:-35,width:288,height:82});
  assert.deepEqual(classified.title,{x:149,y:-35,width:288,height:82});
  assert.deepEqual(general.titleName,{x:282,y:6});
  assert.deepEqual(classified.category.button,{width:88,height:69,stride:69});
  assert.deepEqual(classified.category.plate,{x:135,y:41,width:323,height:34});
  // 分类名居中于底板：`UIStore_Draw` 传的 43 是 30 像素字号的上沿，落到 34 高的底板里就是中线 58。
  assert.deepEqual(classified.category.name,{x:296,y:58});
  // 分类列自己的修饰：上下两块 103×24 端盖夹住一条 14×411 竖条。
  assert.deepEqual(classified.categoryColumn,{cap:{x:18,y:0,bottom:407,width:103,height:24},
    divider:{x:111,y:10,width:14,height:411}});
  // 背包栏右侧那 6 个按钮与背包页同一列：右框内 (389,12)，组内 y 步长 0x46。
  assert.deepEqual(general.sideButtons,{x:873,y:12,width:57,height:57,offsets:[0,0x46,0x8b,0xd0,0x115,0x15b]});
  assert.deepEqual(general.bag,{x:518,y:27,width:323,height:323,stride:83,columns:4});
  assert.deepEqual(general.money,{x:518,y:365,plate:{x:518,y:368,width:323,height:34},
    stride:103,coin:{width:44,height:40},digit:{x:44,y:6},color:'#ffffff'});
  assert.deepEqual(general.badge,{x:67,y:47,color:'#ffffff'});
  // 说明面板与背包那份同规则；横向落点由调用方按左右栏给，纵向是本作适配值。
  // 说明面板与背包共用同一份原版矩形：442×431，纵向与所盖那一栏的顶边对齐。
  assert.equal(DESCRIPTION_PANEL.y,0);
  // 442 是这套子件的设计宽度；实际面板与它盖住的那一栏同宽（背包栏 395、人物栏 409、货架栏 462）。
  assert.equal(DESCRIPTION_PANEL.width,442);
  assert.equal(descriptionPanel(395).width,395);
  assert.equal(descriptionPanel(409).width,409);
  assert.equal(descriptionPanel(442).scroll.width,DESCRIPTION_PANEL.scroll.width);
  assert.equal(descriptionPanel(395).scroll.width,395-20-64,'从右边收窄');
  assert.equal(descriptionPanel(395).close.x,395-61,'关闭按钮跟着右边缘走（离右边缘 61 = 67 宽 + 探出 6）');
  assert.equal(descriptionPanel(395).menu.width,377-47,'底部菜单行同步收窄');
  // 比 442 宽时（分类商店卖出，面板盖 462 宽的货架栏）三样都要跟着往右摊开，
  // 否则关闭按钮与底部按钮行会缩在面板左边，不贴右边缘。
  assert.equal(descriptionPanel(462).close.x,462-61,'变宽时关闭按钮仍贴右边缘');
  assert.equal(descriptionPanel(462).scroll.width,378,'变宽时滚动区右侧留边不变');
  assert.equal(descriptionPanel(462).menu.width,377+20,'变宽时菜单行右侧留边不变');
  assert.equal(DESCRIPTION_PANEL.height,431);
  // 面板自带底色：内缩 10 取原版（UIDesc_Draw 的 GRPX_FillRectAlpha 参数 0x3c=60），
  // 本作把不透明度提到 85%，让面板压得住底下那一栏。
  assert.equal(DESCRIPTION_PANEL.inset,10);
  assert.equal(DESCRIPTION_PANEL.background,0x000000);
  assert.equal(DESCRIPTION_PANEL.backgroundAlpha,.85);
  // 物品名在面板顶上，不在滚动区里：落点 (20,22)、右边留 82 给关闭按钮。
  assert.deepEqual(DESCRIPTION_PANEL.title,{x:20,y:22,right:82,size:24});
  assert.deepEqual(DESCRIPTION_PANEL.scroll,{x:20,y:60,width:358,height:258});
  assert.deepEqual(DESCRIPTION_PANEL.close,{x:381,y:-6,size:67},'原版 349，本作右移到贴住右上角');
  assert.deepEqual(DESCRIPTION_PANEL.menu.offsets[1],126);
  // 数量框的内容按原版摆：图标在计数区左侧，数量左对齐于其右侧，金额与文本底板左端对齐。
  const quantity=tradeLayout.quantity;
  // 黑底是 `GRPX_FillRect(x+35, y+35, 宽−70, 高−70)`，不是九宫格边框的内区。
  assert.deepEqual(quantity.plate,{x:35,y:35,width:380,height:280});
  assert.deepEqual(quantity.icon,{x:150,y:47,size:64});
  assert.deepEqual(quantity.count,{x:233,y:56,color:'#e2cb9e'});
  assert.deepEqual(quantity.textPlate,{x:63,y:168,width:323});
  assert.deepEqual(quantity.money,{x:63,y:165});
  // 确认框按原版 `UIPopupMsg_SetLayout` 定高：`max(文本高, 235) + 115`，
  // 所以正文不多的确认框与数量框同为 450×350，按钮行也同在 275。
  const message=tradeMessageLayout(2,true);
  assert.equal(tradeMessageLayout(1,false).height,350);
  assert.equal(message.height,350);
  assert.equal(message.textPlate.width,377);
  assert.deepEqual(message.button,{width:125,height:55,y:275,left:45,right:280});
  for(const [name,box] of [['数量框',quantity],['确认框',message]] as const){
    assert.deepEqual(box.plate,{x:35,y:35,width:380,height:280},`${name}黑底`);
    assert.deepEqual(box.button,{width:125,height:55,y:275,left:45,right:280},`${name}按钮行`);
    // 按钮行从黑底往上 40 像素起画（275 = 35+280−40），下沿探出黑底 15 像素，与原版一致。
    assert.equal(box.button.y+box.button.height,box.plate.y+box.plate.height+15,`${name}按钮行相对黑底`);
  }
  assert.ok(quantity.field.y>=quantity.plate.y,'数量框计数区落在黑底内');
  assert.ok(quantity.textPlate.y+34<=quantity.plate.y+quantity.plate.height,'数量框金额底板落在黑底内');
  assert.ok(message.text.y>=35,'确认框问题行落在黑底内');
  // 弹层图框：四角 81×81，横条 380×81，竖条 81×304（图组 19 的边框家族）。
  assert.deepEqual(POPUP_FRAME.corner,{size:81,outer:46,inner:35});
  assert.deepEqual(POPUP_FRAME.horizontal,{height:81,top:-46,bottom:45,inset:35});
  assert.deepEqual(POPUP_FRAME.vertical,{width:81,left:-46,right:45,top:35});
});

test('shop assets keep their native pixel sizes',()=>{
  for(const [file,width,height] of [['gold',44,40],['silver',44,40],['copper',44,40],['slot',74,74],['selection',84,84],
      ['merchant-title',288,82],['text-plate-left',9,34],['text-plate-right',9,34],
      ['count-left',51,58],['count-left-pressed',51,58],['count-right',51,58],['count-right-pressed',51,58]] as const){
    const png=fs.readFileSync(new URL(`../public/assets/ui/shop/${file}.png`,import.meta.url));
    assert.equal(png.readUInt32BE(16),width,`${file} 宽度`);assert.equal(png.readUInt32BE(20),height,`${file} 高度`);
  }
  for(const [file,width,height] of [['category-cap-top',103,24],['category-cap-bottom',103,24],['category-divider',14,411]] as const){
    const png=fs.readFileSync(new URL(`../public/assets/ui/shop/${file}.png`,import.meta.url));
    assert.equal(png.readUInt32BE(16),width,`${file} 宽度`);assert.equal(png.readUInt32BE(20),height,`${file} 高度`);
  }
  // 弹层图框来自图组 19：四角 81×81、横条 380×81、竖条 81×304。
  for(const [file,width,height] of [['popup-corner-nw',81,81],['popup-corner-ne',81,81],['popup-corner-sw',81,81],['popup-corner-se',81,81],
      ['popup-edge-horizontal',380,81],['popup-edge-vertical',81,304]] as const){
    const png=fs.readFileSync(new URL(`../public/assets/ui/menus/${file}.png`,import.meta.url));
    assert.equal(png.readUInt32BE(16),width,`${file} 宽度`);assert.equal(png.readUInt32BE(20),height,`${file} 高度`);
  }
  for(const file of fs.readdirSync(new URL('../public/assets/ui/shop/',import.meta.url)).filter(name=>/^(dagger|bow|cloth|hat)\.png$/.test(name))){
    const png=fs.readFileSync(new URL(`../public/assets/ui/shop/${file}`,import.meta.url));
    assert.equal(png.readUInt32BE(16),88,`${file} 宽度`);assert.equal(png.readUInt32BE(20),69,`${file} 高度`);
  }
});

test('shop panel draws money, slots and badges at the native coordinates',()=>{
  const {surface}=open('merchandise-dealer-b09d9585');
  // 两栏只画图框，不铺底：面板里露出来的是黑色 65% 遮罩下的世界画面。
  assert.deepEqual(surface.calls.filter(call=>call.kind==='border').map(call=>[call.x,call.y,call.width,call.height]),
    [[85,0,395,431],[484,0,395,431]]);
  assert.equal(surface.calls.filter(call=>call.kind==='frame').length,0,'两栏都不铺底');
  const title=surface.images.find(call=>String(call.file).includes('merchant-title'))!;
  assert.deepEqual([title.x,title.y,title.width,title.height],[138,-35,288,82]);
  assert.deepEqual([surface.texts('杂货商人')[0].x,surface.texts('杂货商人')[0].y], [282,6]);
  const slots=surface.images.filter(call=>String(call.file).includes('/slot.png'));
  assert.equal(slots.length,32);assert.deepEqual([slots[0].x,slots[0].y,slots[0].width,slots[0].height],[121,80,74,74]);
  const icons=surface.images.filter(call=>String(call.file).includes('/items/'));
  assert.ok(icons.every(call=>call.width===64&&call.height===64));
  assert.deepEqual([icons[0].x,icons[0].y],[5,5]);
  // 金币：先币后数字，单位间距 103，数字左对齐于币右侧 44、下移 6、白色。
  const coins=surface.images.filter(call=>/(gold|silver|copper)\.png$/.test(String(call.file)));
  assert.deepEqual(coins.map(call=>[call.x,call.y,call.width,call.height]),[[518,365,44,40],[621,365,44,40],[724,365,44,40]]);
  const digits=surface.calls.filter(call=>call.kind==='text'&&call.color==='#ffffff'&&(call.x as number)>=518);
  assert.deepEqual(digits.map(call=>[call.x,call.y]),[[562,371],[665,371],[768,371]]);
  assert.deepEqual([surface.calls.find(call=>call.kind==='textPlate')!.x,surface.calls.find(call=>call.kind==='textPlate')!.y], [518,368]);
  const scrolls=surface.calls.filter(call=>call.kind==='scroll');
  assert.deepEqual(scrolls.map(call=>[call.x,call.y,call.width,call.height]),[[518,27,323,323]]);
  // 起始背包的恢复药水有 5 个，数量角标按原版画在 (+67,+47)、白色、右对齐。
  const badge=surface.calls.find(call=>call.kind==='text'&&call.value==='5')!;
  assert.equal(badge.color,'#ffffff');assert.deepEqual([(badge.node as Node).origin.x,(badge.node as Node).origin.y],[1,0]);
  assert.deepEqual([badge.x,badge.y],[67,47]);
});

test('classified shops draw the native category column and name plate',()=>{
  const {surface}=open('weapons-dealer-f31d78ce');
  const title=surface.images.find(call=>String(call.file).includes('merchant-title'))!;
  assert.deepEqual([title.x,title.y],[149,-35]);
  const buttons=surface.calls.filter(call=>call.kind==='button'&&String((call.options as Record<string,unknown>).image??'').includes('/shop/'));
  assert.equal(buttons.length,9);
  assert.ok(buttons.every(call=>call.width===88&&call.height===69),'分类按钮保持素材原尺寸');
  assert.deepEqual(buttons.map(call=>call.y),[0,69,138,207,276,345,414,483,552]);
  const plate=surface.calls.find(call=>call.kind==='textPlate')!;
  assert.deepEqual([plate.x,plate.y,plate.width],[135,41,323]);
  const categories=surface.calls.filter(call=>call.kind==='text'&&call.color==='#e2cb9e');
  assert.deepEqual([categories.at(-1)!.x,categories.at(-1)!.y],[296,58]);
  assert.deepEqual([(categories.at(-1)!.node as Node).origin.x,(categories.at(-1)!.node as Node).origin.y],[.5,.5],'分类名居中于底板');
  const scrolls=surface.calls.filter(call=>call.kind==='scroll');
  assert.deepEqual(scrolls.map(call=>[call.x,call.y,call.width,call.height]),[[28,10,88,412],[518,27,323,323]]);
  // 分类列的端盖与竖条：`UIStore_Draw` 画在左框 (0,0)、(0,407) 与 (93,10)。
  const decorations=surface.calls.filter(call=>call.kind==='image'&&/category-(cap|divider)/.test(String(call.file)));
  assert.deepEqual(decorations.map(call=>[String(call.file).split('/').pop(),call.x,call.y,call.width,call.height]),
    [['category-cap-top.png',18,0,103,24],['category-cap-bottom.png',18,407,103,24],['category-divider.png',111,10,14,411]]);
});

test('both shops keep the bag category column on the right of the bag frame',()=>{
  // 原版 `UIStore_DrawInvenBagGroup` 在这 6 格里切换背包分类：卖东西时看到的就是筛出来的那一类，
  // 所以这一列在商店里也是分类按钮，不是空着的。
  const labels=INVENTORY_SIDE_FILTERS.map(filter=>INVENTORY_LABELS[filter]);
  for(const id of ['merchandise-dealer-b09d9585','weapons-dealer-f31d78ce']){
    const {surface,session,draw}=open(id),side=shopLayout(id.startsWith('weapons')).sideButtons;
    const buttons=surface.calls.filter(call=>call.kind==='button'&&labels.includes(String(call.node?.label??'')));
    assert.deepEqual(buttons.map(call=>call.node!.label),labels,`${id} 右侧这一列是六个分类`);
    assert.deepEqual(buttons.map(call=>[call.x,call.y]),side.offsets.map(offset=>[side.x,side.y+offset]));
    assert.ok(buttons.every(call=>call.width===side.width&&call.height===side.height),'按钮 57×57');
    // 外框画在按钮矩形的 −(5,12) 上，与背包页同一套（图组 15 索引 20，选中的叠 19）。
    const frames=surface.calls.filter(call=>call.kind==='image'&&/page-button-/.test(String(call.file)));
    assert.ok(frames.every(call=>call.x===-5&&call.y===-12),'外框落在按钮矩形 −(5,12) 上');
    assert.equal(frames.filter(call=>String(call.file).includes('selected')).length,1,'只有当前分类画选中态');
    assert.equal(frames.length,labels.length+1,'六个常态外框加一个选中外框');
    // 这一列两端的角件只在第一个／最后一个分类被选中时画（原版 `0x1675b4`／`0x1675fc`）。
    const caps=()=>surface.calls.filter(call=>call.kind==='image'&&/column-cap/.test(String(call.file)));
    const pick=(label:string)=>{const call=surface.calls.filter(item=>item.kind==='button'&&String(item.node?.label??'')===label).at(-1)!;(call.action as ()=>void)();draw();};
    // 默认选中的是第一个分类，所以上端角件在；切到中间分类两端都不画。
    assert.deepEqual(caps().map(call=>[String(call.file).split('/').pop(),call.x,call.y,call.width,call.height]),
      [['column-cap-top.png',side.x-19,side.y-12,21,34]],'第一个分类选中时画上端角件');
    pick(labels[2]);
    assert.equal(caps().length,0,'选中的是中间分类时两端不画角件');
    pick(labels.at(-1)!);
    assert.deepEqual(caps().map(call=>[String(call.file).split('/').pop(),call.y]),
      [['column-cap-bottom.png',side.y+side.offsets.at(-1)!+38]],'最后一个分类选中时画下端角件');
    pick(labels[0]);
    // 分类真的在筛背包：默认「全部」看得见所有东西，切到武器只剩武器。
    const sellable=(label:string)=>surface.calls.filter(call=>call.kind==='button'&&String(call.node?.label??'')===label).length;
    session.bag.add('resurrection-prayer');session.bag.add('dagger');draw();
    assert.equal(sellable('出售 复活圣文'),1,'默认全部里能看到不可出售的物品');
    (buttons.find(call=>call.node!.label===INVENTORY_LABELS.weapon)!.action as ()=>void)();draw();
    assert.equal(sellable('出售 短剑'),1,'武器分类里有短剑');
    assert.equal(sellable('出售 复活圣文'),0,'武器分类里没有消耗品');
  }
});

test('picking an item first opens the description panel on the opposite column',()=>{
  const {surface,description,session,draw}=open('merchandise-dealer-b09d9585');
  session.gainMoney(1_000_000);
  const general=shopLayout(false),potion=item('恢复药水（小）');
  // 买入：原版把买入记成 mode 1，说明面板因此落背包那一栏（点选来源的对面）。
  press(surface,'购买 恢复药水（小）');draw();
  assert.equal(surface.visibleCalls,0,'说明面板不占弹层画布');
  assert.deepEqual(surface.frames,[],'主画布上不开弹框');
  assert.equal(description.texts(potion.name).length,1,'面板不画物品图片，只写一行物品名');
  assert.equal(description.texts(potion.typeName).length,0,'正文不再写「药水（恢复）」这类类型名');
  assert.equal(description.texts(`等级 ${potion.level}`).length,potion.level?1:0,'有等级的物品才写等级行（这瓶药水是 0 级）');
  assert.equal(description.texts(potion.description).length,1);
  // 说明面板整块画在它自己那一层上，内容块上不留任何一件；否则停在右栏时会被背包格子的图层盖住。
  assert.equal(surface.descriptionFills.length,0,'底色不画在内容块上');
  assert.equal(surface.descriptionBorders.length,0,'图框不画在内容块上');
  assert.equal(surface.texts(potion.description).length,0);
  // 买入时面板盖背包栏，所以宽度取 395。
  // 买入时面板盖背包栏：宽度受限于右侧那一列分类按钮，右边缘停在分类列外框之前。
  const panel=descriptionPanel(BAG_DESCRIPTION_WIDTH),left=general.bagFrame.x,close=boxButton(description,'关闭'),buy=boxButton(description,'购买');
  // 面板自带底色与图框，落在它盖住的那一栏上；底色内缩 10。
  assert.deepEqual(description.descriptionBorders.map(call=>[call.x,call.y,call.width,call.height]),
    [[left,panel.y,panel.width,panel.height]]);
  assert.equal(panel.width,BAG_DESCRIPTION_WIDTH,'盖背包栏时面板收窄到分类列之前');
  assert.equal(panel.close.x+panel.close.size,panel.width+6,'收窄后关闭钮仍贴在面板右缘（探出 6）');
  assert.deepEqual(description.descriptionFills.map(call=>[call.x,call.y,call.width,call.height]),
    [[left+panel.inset,panel.y+panel.inset,panel.width-panel.inset*2,panel.height-panel.inset*2]]);
  // 物品名画在面板顶上（不在滚动区里），右侧留出关闭按钮那段宽度。
  assert.deepEqual(description.texts(potion.name).map(call=>[call.x,call.y,call.width,call.size]),
    [[left+panel.title.x,panel.y+panel.title.y,panel.width-panel.title.right,panel.title.size]]);
  // 关闭钮用原版那张 67×67 的圆图，落点取面板的 close 矩形。
  assert.deepEqual([close.x,close.y],[left+panel.close.x,panel.y+panel.close.y]);
  assert.equal((close.options as {image?:string}).image,'assets/ui/menus/close.png','关闭钮画原版圆钮，不是方块按钮');
  assert.equal((close.options as {pressed?:string}).pressed,'assets/ui/menus/close-pressed.png','按下时叠原版那张橙色圆环，不在圆钮上罩方块');
  assert.deepEqual([buy.x,buy.y],[left+panel.menu.x+panel.menu.offsets[1],panel.y+panel.menu.y]);
  const scroll=description.calls.filter(call=>call.kind==='scroll').at(-1)!;
  assert.deepEqual([scroll.x,scroll.y,scroll.width,scroll.height],
    [left+panel.scroll.x,panel.y+panel.scroll.y,panel.scroll.width,panel.scroll.height]);
  assert.deepEqual([buy.width,buy.height],[panel.menu.button.width,panel.menu.button.height]);
  // 关闭按钮把面板撤掉，回到只有货架与背包的商店界面。
  (close.action as ()=>void)();draw();
  assert.equal(description.texts(potion.description).length,0);
  // 卖出：mode 0 落货架那一栏，底部改挂"出售"，堆叠物品补一行持有数量。
  press(surface,'出售 恢复药水（小）');draw();
  const sell=boxButton(description,'出售');
  const shelfPanel=descriptionPanel(general.leftFrame.width);
  assert.deepEqual([sell.x,sell.y],[general.leftFrame.x+shelfPanel.menu.x+shelfPanel.menu.offsets[1],panel.y+shelfPanel.menu.y]);
  assert.equal(shelfPanel.width,general.leftFrame.width,'卖出时与货架栏同宽');
  assert.equal(description.descriptionBorders.at(-1)!.x,general.leftFrame.x,'卖出时面板落在货架那一栏');
  assert.equal(description.texts(`数量：${session.bag.get(session.bag.entries[0].id)!.quantity}`).length,0,'数量显示在物品格角标中');
  // 不可出售的物品跳过说明面板，仍按原样直接提示。
  session.bag.add('resurrection-prayer');draw();
  press(surface,'出售 复活圣文');draw();
  assert.equal(surface.texts('此物品无法出售').length,1);
  assert.equal(description.texts(item('复活圣文').description).length,0);
});

test('batch sale hides unsellable items, toggles picks and sells the whole stack at once',()=>{
  const {surface,session,store,draw}=open('merchandise-dealer-b09d9585');
  session.bag.add('resurrection-prayer');draw();
  press(surface,'批量出售');draw();
  assert.ok(surface.buttons.some(call=>String(call.node?.label)==='退出批量'),'开启后按钮变成退出批量');
  assert.ok(!surface.buttons.some(call=>String(call.node?.label)==='选择 复活圣文'),'批量模式隐藏不可出售物品');
  const entry=session.bag.entries.find(value=>value.item==='healing-potion-s')!;
  const before=session.money,price=store.sellPrice(entry)*entry.quantity;
  press(surface,'选择 恢复药水（小）');draw();
  const action=surface.buttons.find(call=>String(call.node?.label)==='出售选中')!;
  assert.equal((action.options as {disabled?:boolean}).disabled,false);
  assert.ok(surface.calls.some(call=>call.kind==='text'&&String(call.value).startsWith('合计 ')),'金额栏改显示本次合计');
  (action.action as ()=>void)();draw();
  assert.equal(session.money,before+price);assert.equal(session.bag.count('healing-potion-s'),0,'整组一次卖完');
  assert.ok(surface.buttons.some(call=>String(call.node?.label)==='出售选中'),'卖完仍留在批量模式');
});

test('trade follows the native steps: description, quantity box, then confirmation',()=>{
  const {surface,description,session,draw}=open('merchandise-dealer-b09d9585');
  // 给够金币，确认框里就只有问题行，不再多一行「金币不足」。
  session.gainMoney(1_000_000);
  assert.equal(surface.visibleCalls,0,'没有选中时不开弹层');
  // 原版点商品先弹物品说明面板，点面板上的"购买"才进数量框；堆叠商品可一次买 1–99。
  press(surface,'购买 恢复药水（小）');draw();
  assert.equal(description.texts(item('恢复药水（小）').description).length,1,'说明面板画出物品说明');
  (boxButton(description,'购买').action as ()=>void)();draw();
  const {field,step,button,plate,icon,textPlate}=tradeLayout.quantity;
  // 弹层用的是图组 19 的边框家族，不是内容栏那套九宫格。
  assert.deepEqual(popupFrame(surface),nativePopupFrame(450,350));
  // 框内先铺黑底，再画物品图标与计数区。
  assert.deepEqual(surface.calls.filter(call=>call.kind==='rect').map(call=>[call.x,call.y,call.width,call.height]),
    [[plate.x,plate.y,plate.width,plate.height]]);
  const itemIcon=surface.images.find(call=>call.x===icon.x&&call.y===icon.y);
  assert.ok(itemIcon,'数量框画了物品图标');
  assert.deepEqual([itemIcon.width,itemIcon.height],[icon.size,icon.size]);
  const arrows=surface.calls.filter(call=>call.kind==='button'&&String((call.options as Record<string,unknown>|undefined)?.image??'').includes('count-'));
  assert.deepEqual(arrows.map(call=>[call.x,call.y,call.width,call.height]),[[95,50,51,58],[95+209,50,51,58]]);
  // 数量左对齐于计数区右侧、米色；金额与 323 宽的文本底板左端对齐。
  const count=surface.calls.find(call=>call.kind==='text'&&call.value==='1'&&call.x===233)!;
  assert.deepEqual([count.y,count.color],[56,'#e2cb9e']);
  assert.deepEqual([(count.node as Node).origin.x],[0]);
  const moneyPlate=surface.calls.find(call=>call.kind==='textPlate'&&call.x===textPlate.x&&call.y===textPlate.y)!;
  assert.equal(moneyPlate.width,323);
  assert.deepEqual([boxButton(surface,'确定').x,boxButton(surface,'确定').y,boxButton(surface,'确定').width,boxButton(surface,'确定').height],
    [button.left,button.y,button.width,button.height]);
  assert.deepEqual([boxButton(surface,'取消').x,boxButton(surface,'取消').y],[button.right,button.y]);
  // 数量框确认后是只有文字、金额与两个按钮的确认框，金额显示单价×数量。
  (boxButton(surface,'确定').action as ()=>void)();draw();
  // 框从画布左上角开始画，垂直居中交给锚点；桩 Surface 不传父画布，所以只看框内坐标。
  const message=tradeMessageLayout(1,true),boxTop=0;
  assert.deepEqual(popupFrame(surface),nativePopupFrame(450,message.height));
  assert.equal(surface.texts('确定购买 恢复药水（小）？').length,1);
  // 面板本身的金币仍在 (518,365)，弹层里的金额画在弹层画布坐标上。
  const coins=surface.images.filter(call=>/(gold|silver|copper)\.png$/.test(String(call.file))&&(call.x as number)<400);
  assert.deepEqual(coins.map(call=>[call.x,call.y]),
    [0,103,206].map(offset=>[message.money.x+offset,boxTop+message.money.y]));
  // 问题行、金额、按钮行三段互不重叠，且按钮行到框底留出内边距。
  // 正文落在黑底上半区（内缩 35 到 235）里居中：text.y 是这一行的上沿。
  assert.ok(message.text.y>=message.plate.y&&message.text.y+34<=message.plate.y+200,'问题行落在黑底上半区');
  const question=surface.texts('确定购买 恢复药水（小）？')[0];
  assert.deepEqual([(question.node as Node).origin.x,(question.node as Node).origin.y],[.5,0],'纵轴原点取顶边');
  const buttonTop=boxTop+message.button.y,buttonBottom=buttonTop+message.button.height;
  assert.ok((question.y as number)+16<=(coins[0].y as number),'问题行不压金额');
  assert.ok((coins[0].y as number)+40<=buttonTop,'金额不压按钮行');
  assert.ok(boxTop+message.height-buttonBottom>=20,'按钮行到框底留边');
  assert.equal(field.width,260);assert.equal(step.height,58);
});

test('each dialog centres its own box in the menu canvas',()=>{
  const {surface,description,session,draw}=open('merchandise-dealer-b09d9585');
  session.gainMoney(1_000_000);
  const centred=(width:number,height:number)=>[(1024-width)/2,(640-height)/2];
  press(surface,'购买 恢复药水（小）');draw();
  (boxButton(description,'购买').action as ()=>void)();draw();
  const quantity=tradeLayout.quantity;
  assert.deepEqual([surface.root.x,surface.root.y],centred(quantity.width,quantity.height),'数量框按自己的尺寸居中');
  // 确认框按自己的尺寸居中；它与数量框同为原版的 450×350。
  (boxButton(surface,'确定').action as ()=>void)();draw();
  const message=tradeMessageLayout(1,true);
  assert.equal(message.height,quantity.height,'确认框与数量框同为原版的 450×350');
  assert.deepEqual([surface.root.x,surface.root.y],centred(message.width,message.height),'确认框按自己的尺寸居中');
});

test('non-stackable and unsellable items skip the quantity box',()=>{
  const weapons=open('weapons-dealer-f31d78ce');
  weapons.session.gainMoney(1_000_000);
  press(weapons.surface,'购买 短剑');weapons.draw();
  // 说明面板之后，不可堆叠商品直接进确认框，没有数量框这一步。
  (boxButton(weapons.description,'购买').action as ()=>void)();weapons.draw();
  const purchase=tradeMessageLayout(1,true);
  assert.deepEqual(popupFrame(weapons.surface),nativePopupFrame(450,purchase.height),'不可堆叠商品直接确认');
  // 复活圣文不能卖回：点背包格只给提示，且只有一个居中的确定按钮。
  const general=open('merchandise-dealer-b09d9585');
  general.session.bag.add('resurrection-prayer');general.draw();
  press(general.surface,'出售 复活圣文');general.draw();
  assert.equal(general.surface.texts('此物品无法出售').length,1);
  const notice=tradeMessageLayout(1,false),noticeTop=0;
  assert.deepEqual([boxButton(general.surface,'确定').x,boxButton(general.surface,'确定').y],[(450-125)/2,noticeTop+notice.button.y]);
  assert.equal(general.surface.buttons.filter(call=>call.label==='取消').length,0);
});

test('quantity arrows repaint only the box, never the whole menu',()=>{
  let repaints=0;
  const {surface,description,store,session,draw}=open('merchandise-dealer-b09d9585',()=>{repaints++;});
  session.gainMoney(1_000_000);
  press(surface,'购买 恢复药水（小）');draw();
  (boxButton(description,'购买').action as ()=>void)();draw();
  const arrow=(name:string)=>surface.calls.find(call=>call.kind==='button'&&String((call.options as Record<string,unknown>|undefined)?.image??'').includes(name))!;
  const plus=arrow('count-right'),minus=arrow('count-left');
  const count=()=>surface.calls.find(call=>call.kind==='text'&&call.x===233&&call.y===56)!.node as Node;
  // 弹层里那行金额的三个数字：横坐标都在弹层画布上（<400），面板自己的金币在 562 之后。
  const digits=()=>surface.calls.filter(call=>call.kind==='text'&&call.size===21&&call.color==='#ffffff'&&(call.x as number)<400)
    .map(call=>(call.node as Node).text);
  const offer=store.offers.find(value=>!value.sold&&session.bag.catalog.items[value.instance.item].name==='恢复药水（小）')!;
  const price=store.buyPrice(offer.id);
  assert.deepEqual([count().text,(minus.node as Node).interactive],['1',false],'数量 1 时减号是灰的');
  const before=repaints;
  (plus.action as ()=>void)();
  assert.equal(repaints,before,'点加号不重画整个菜单');
  assert.equal(count().text,'2','数量就地改成 2');
  const doubled=splitMoney(price*2);
  assert.deepEqual(digits(),[String(doubled.gold),String(doubled.silver),String(doubled.copper)],'金额跟着数量一起改');
  assert.equal((minus.node as Node).interactive,true,'数量回到 2 时减号恢复可点');
  (minus.action as ()=>void)();
  assert.equal(repaints,before,'点减号同样不重画');
  assert.deepEqual([count().text,(minus.node as Node).interactive],['1',false]);
});
