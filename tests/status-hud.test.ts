import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boundedHealth,buffIconBlinking,buffIconPosition,gaugeFillWidth,memberColumnLayout,memberPanelIds,targetNameAnchor,targetNameColor } from '../src/domain/status-hud.ts';
import { parseStatusHud,parseBattle,parseCharacterStats,parseItemCatalog,parseCampaign,parseStoryClasses } from '../src/application/content-validation.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import { Session } from '../src/domain/session.ts';
import type Phaser from 'phaser';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { OverheadStatus } from '../src/rendering/overhead-status.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../src/generated/ui-atlas.ts';
import { sourceAssetPath } from '../tools/asset-source.ts';
const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const skin=parseStatusHud(read('status-hud')),battle=parseBattle(read('battle'));

const atlasFrames = new Map<string, Record<string, unknown>>();
function uiAtlasFrame(file: string): boolean {
  const entry = UI_ATLAS_FRAMES[file];
  const page = entry && UI_ATLAS_PAGES[entry.page];
  if (!entry || !page) return false;
  let frames = atlasFrames.get(page.data);
  if (!frames) {
    frames = (JSON.parse(fs.readFileSync(new URL(`../public/${page.data}`, import.meta.url), 'utf8')) as { frames: Record<string, unknown> }).frames;
    atlasFrames.set(page.data, frames);
  }
  return Boolean(frames[entry.frame]);
}
/** 状态栏图片要么作为单文件留在 public，要么已经在界面图集里。 */
const shippedImage = (file: string) => fs.existsSync(new URL(`../public/${file}`, import.meta.url)) || uiAtlasFrame(file);

test('native gauge crops full, half, subpixel and empty health without stretching',()=>{
  for(const width of [16,40,212]){
    assert.equal(gaugeFillWidth(100,100,width),width);assert.equal(gaugeFillWidth(50,100,width),width/2);
    assert.equal(gaugeFillWidth(0,100,width),0);assert.equal(gaugeFillWidth(1,1000,width),0);
    assert.equal(gaugeFillWidth(101,100,width),width);assert.equal(gaugeFillWidth(-1,100,width),0);assert.equal(gaugeFillWidth(0,0,width),0);
  }
  assert.equal(boundedHealth(99.9,100),99);assert.equal(boundedHealth(-1,100),0);assert.equal(boundedHealth(999,100),100);
  for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>boundedHealth(value,100));
  for(const part of Object.values(skin.assets))assert.ok(shippedImage(part),part);
  const missing=structuredClone(skin);delete (missing.assets as Partial<typeof skin.assets>)['target-fill'];assert.throws(()=>parseStatusHud(missing),/target-fill/);
  const bad=structuredClone(skin);bad.target.gauge.fillWidth=1000;assert.throws(()=>parseStatusHud(bad),/超出/);
});

test('overhead bars retain native world-pixel layout, colours and player head anchors',()=>{
  assert.deepEqual(skin.overhead.health,{x:-8,y:-19,width:16,height:2,color:'#28c000'});
  assert.deepEqual(skin.overhead.mana,{x:-8,y:-16,width:16,height:2,color:'#0f7cf9'});
  for(const kind of ['frame','leader'] as const){
    const rect=skin.overhead[kind],png=fs.readFileSync(sourceAssetPath(skin.assets[`overhead-${kind}`]));
    assert.equal(png.readUInt32BE(16),rect.width);assert.equal(png.readUInt32BE(20),rect.height);
  }
  for(const entry of battle.classes)assert.deepEqual(entry.actor.headAnchor,{x:0,y:-22});
  for(const entry of read('story-classes').classes)assert.deepEqual(entry.playerActor.headAnchor,{x:0,y:-22});
  assert.deepEqual(read('world').actors.kiyan.headAnchor,{x:0,y:-22});
  const bad=structuredClone(skin);bad.overhead.health.color='green';assert.throws(()=>parseStatusHud(bad),/六位颜色/);
  const missing=structuredClone(battle);delete missing.classes[0].actor.headAnchor;assert.throws(()=>parseBattle(missing),/头部锚点/);
  const story=read('story-classes');delete story.classes[0].playerActor.headAnchor;assert.throws(()=>parseStoryClasses(story),/头部锚点/);
});

test('overhead rendering follows subscribed player state and removes subscriptions on actor destruction',()=>{
  class Shape {
    x=0;y=0;width=0;height=0;color=0;visible=true;children:Shape[]=[];destroyed?:()=>void;
    setOrigin(){return this;}setName(){return this;}
    setSize(width:number,height:number){this.width=width;this.height=height;return this;}
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
    setVisible(visible:boolean){this.visible=visible;return this;}
    add(child:Shape){this.children.push(child);return this;}
    once(_event:string,listener:()=>void){this.destroyed=listener;return this;}
    destroy(){this.destroyed?.();this.destroyed=undefined;for(const child of this.children)child.destroy();}
  }
  const rectangles:Shape[]=[],parent=new Shape();
  const scene={add:{image:()=>new Shape(),rectangle:(x:number,y:number,w:number,h:number,color:number)=>{
    const shape=new Shape().setPosition(x,y).setSize(w,h);shape.color=color;rectangles.push(shape);return shape;
  },container:(x:number,y:number,children:Shape[])=>{const shape=new Shape().setPosition(x,y);shape.children=children;return shape;}}};
  const character={actor:battle.classes[0].actor,container:parent};
  let listener:(()=>void)|undefined,unsubscribed=0,reads=0;
  const player={level:1,health:100,maxHealth:100,mana:50,maxMana:100,experience:0,nextLevelExperience:100};
  const hud=new OverheadStatus(scene as unknown as Phaser.Scene,character as unknown as CharacterVisual,skin,()=>{reads++;return player;},
    fn=>{listener=fn;return()=>{listener=undefined;unsubscribed++;};});
  hud.setVisible(true);assert.equal(parent.children[0],hud.container);
  for(let i=0;i<60;i++)hud.setVisible(true);assert.equal(reads,1);
  assert.equal(hud.container.y,-22);assert.equal(rectangles[0].width,16);assert.equal(rectangles[1].width,8);
  assert.equal(rectangles[0].color,0x28c000);assert.equal(rectangles[1].color,0x0f7cf9);
  player.health=50;player.mana=0;listener!();assert.equal(rectangles[0].width,8);assert.equal(rectangles[1].visible,false);
  player.health=0;listener!();assert.equal(rectangles[0].visible,false);
  player.health=100;player.mana=100;listener!();assert.equal(rectangles[0].width,16);assert.equal(rectangles[1].visible,true);
  hud.setVisible(false);assert.equal(hud.container.visible,false);hud.setVisible(true);assert.equal(hud.container.visible,true);
  parent.destroy();assert.equal(unsubscribed,1);assert.equal(listener,undefined);hud.destroy();assert.equal(unsubscribed,1);
});

test('target names keep native level-difference colours except the lowest tier is white',()=>{
  for(const [difference,color] of [[8,'#9c00ff'],[7,'#ff0000'],[5,'#ff0000'],[4,'#fcff00'],[2,'#fcff00'],[1,'#ffffff'],[-1,'#ffffff'],[-2,'#00ff00'],[-4,'#00ff00'],[-5,'#00b4ff'],[-7,'#00b4ff'],[-8,'#ffffff']] as const)
    assert.equal(targetNameColor(skin,20,{level:20+difference,sceneLevel:false}),color);
  assert.equal(targetNameColor(skin,1,{level:100,sceneLevel:true}),'#ffffff');
});

test('target name is anchored on the panel centre so both native lines stay centred',()=>{
  const anchor=targetNameAnchor(skin);
  assert.equal(anchor.x,skin.target.width/2,'名字横向锚点取面板框中心');
  assert.equal(anchor.y,skin.target.name.y,'名字纵向保持框顶边下 10 像素');
  assert.equal(skin.target.name.x+skin.target.name.width,skin.target.width-skin.target.name.x,'名字框左右留白对称');
});

test('target special mark is centred under the health bar on the native panel',()=>{
  const mark=skin.target.specialMark;
  assert.ok(mark);
  assert.equal(mark.centerX,skin.target.width/2,'特殊标记取面板横向中心');
  assert.equal(mark.centerY,80);
  assert.equal(mark.width,77);assert.equal(mark.height,37);
  const barBottom=skin.target.gauge.y+skin.target.gauge.height;
  assert.equal(mark.centerY-mark.height/2-barBottom,5.5,'星星上沿紧贴血条下方');
  const png=fs.readFileSync(sourceAssetPath(skin.assets['target-frame']));
  assert.equal(png.readUInt32BE(16),skin.target.width);
  assert.equal(png.readUInt32BE(20),skin.target.height);
  const off=structuredClone(skin);off.target.specialMark!.centerY=500;
  assert.throws(()=>parseStatusHud(off),/特殊标记超出面板/);
});

test('six class health writes notify, clamp, refill on leveling and preserve class isolation',()=>{
  const stats=parseCharacterStats(read('character-stats')),items=parseItemCatalog(read('items'));
  for(const entry of battle.classes){
    const hero=new BattleCharacter(entry.id,stats,items),other=new BattleCharacter(entry.id,stats,items);let updates=0;
    const unsubscribe=hero.subscribe(()=>updates++);
    const snapshot=hero.player,max=snapshot.maxHealth;hero.setHealth(max/2);assert.equal(hero.player.health,Math.trunc(max/2));
    assert.equal(snapshot.health,max);assert.equal(other.player.health,max);
    hero.setHealth(-1);assert.equal(hero.player.health,0);assert.throws(()=>hero.setHealth(NaN));
    hero.addExperience(hero.player.nextLevelExperience);assert.equal(hero.player.health,hero.player.maxHealth);
    hero.allocate('vitality',1);hero.setHealth(hero.player.maxHealth+100);assert.equal(hero.player.health,hero.player.maxHealth);
    hero.resetAttributes();assert.ok(hero.player.health<=hero.player.maxHealth);assert.ok(updates>=5);
    unsubscribe();const count=updates;hero.setHealth(0);assert.equal(updates,count);
  }
});

test('story health snapshots are immutable and notify their own session',()=>{
  const p={level:1,health:100,maxHealth:100,mana:20,maxMana:20,experience:0,nextLevelExperience:100};
  const session=new Session(parseCampaign(read('campaign')),p),before=session.player;let updates=0;
  const off=session.subscribe(()=>updates++);session.setHealth(40.8);assert.equal(session.player!.health,40);assert.equal(before!.health,100);
  assert.ok(Object.isFrozen(session.player));session.setHealth(999);assert.equal(session.player!.health,100);
  session.setHealth(-2);assert.equal(session.player!.health,0);assert.throws(()=>session.setHealth(NaN));assert.ok(updates>=3);off();
});

test('553 native enemy definitions initialize independent health and retain it across position changes',()=>{
  assert.equal(battle.enemies.length,553);assert.ok(battle.enemies.every(e=>Number.isInteger(e.maxHealth)&&e.maxHealth>0));
  assert.deepEqual(battle.enemies.slice(0,3).map(e=>e.level),[null,null,null]);
  const config=new EnemyRoster(),definition=battle.enemies[3],first=config.placeEnemy(definition.id,10,10),second=config.placeEnemy(definition.id,20,20);
  assert.equal(config.enemyStatus(first.key,definition)!.health,definition.maxHealth);
  config.setEnemyHealth(first.key,definition.maxHealth/2,definition);config.moveEnemy(first.key,30,40);
  assert.equal(config.enemyStatus(first.key,definition)!.health,Math.trunc(definition.maxHealth/2));
  assert.equal(config.enemyStatus(second.key,definition)!.health,definition.maxHealth);
  config.setEnemyHealth(first.key,0,definition);assert.equal(config.enemyStatus(first.key,definition)!.health,0);
  config.removeEnemy(first.key);assert.equal(config.enemyStatus(first.key,definition),undefined);
  const prop=battle.enemies[0],placed=config.placeEnemy(prop.id,0,0);assert.equal(config.enemyStatus(placed.key,prop,7)!.level,7);
  const bad=structuredClone(battle);bad.enemies[3].maxHealth=0;assert.throws(()=>parseBattle(bad),/maxHealth/);
});

test('member panels follow the adjusted slots, portrait sizes and visible right edge',()=>{
  assert.deepEqual(skin.member.slots,[10,110,210]);
  // 体验版显示尺寸：主面板略小于原版素材，队友面板放大。
  assert.deepEqual([skin.member.width,skin.member.height],[87,92]);
  assert.deepEqual([skin.member.portrait.width,skin.member.portrait.height],[63.87,66.81]);
  assert.deepEqual([skin.player.width,skin.player.height],[98,104]);
  // 右缘对齐取素材可见边框；两块面板图幅的透明留白不同，不能拿图幅宽度相减。
  assert.deepEqual([skin.player.inset.right,skin.member.inset.right],[5.6,3.3]);
  for(const [side,panel] of [['当前',skin.player],['队友',skin.member]] as const){
    const gauges=Object.values(panel.gauges);
    for(const g of gauges){
      assert.ok(g.x>=0&&g.y>=0,side);
      assert.ok(g.x+g.fillOffset+g.fillWidth+g.endWidth<=panel.width,side);
      assert.ok(g.y+g.height<=panel.height,side);
      // 条只占框体自己的凹槽，右端不能压到等级徽章；队友凹槽 35 源像素，不能套用主面板的 40。
      assert.ok(g.x+g.fillOffset+g.fillWidth+g.endWidth<=panel.level.x,`${side}条压到等级徽章`);
    }
    for(const rect of [panel.portrait,panel.level]){assert.ok(rect.x>=0&&rect.y>=0);assert.ok(rect.x+rect.width<=panel.width&&rect.y+rect.height<=panel.height,side);}
  }
  // 队友面板的槽位按原版非当前成员分支：79×84 素材内 x=12.5、y=61/67/73，再缩放到 87×92。
  assert.deepEqual([skin.member.gauges.health.x,skin.member.gauges.mana.x,skin.member.gauges.experience.x],[13.77,13.77,13.77]);
  assert.deepEqual([skin.member.gauges.health.y,skin.member.gauges.mana.y,skin.member.gauges.experience.y],[66.81,73.38,79.95]);
  // 原版头像不裁剪：槽与头像在纵向上本来就重叠，由框体盖住头像下缘。
  assert.ok(skin.member.gauges.experience.y>skin.member.gauges.mana.y&&skin.member.gauges.mana.y>skin.member.gauges.health.y);
  // 队友面板只有 87 宽，等级数字落在三条槽的高度带里（原版本来就把数字画在槽上）。
  const band=[skin.member.gauges.health.y,skin.member.gauges.experience.y+skin.member.gauges.experience.height];
  const levelCentre=skin.member.level.y+skin.member.level.height/2;
  assert.ok(levelCentre>=band[0]&&levelCentre<=band[1]);
  // 等级数字要对准 member-frame 右下角的圆形徽章：素材暗色圆心 (60.5,63.5)，按 87×92 缩放。
  assert.ok(Math.abs(skin.member.level.x+skin.member.level.width/2-66.62)<0.1,'等级数字横向偏离徽章圆心');
  assert.ok(Math.abs(levelCentre-69.55)<0.1,'等级数字纵向偏离徽章圆心');
});

test('buff icons straddle the panel bottom-left corner and blink only inside the last 30 logic frames',()=>{
  const icons=skin.buffIcons;assert.deepEqual([icons.size,icons.step],[24,27]);
  for(const panelHeight of [skin.player.height,skin.member.height]){
    const first=buffIconPosition(icons,panelHeight,0);
    // 下边缘齐面板底边；右边缘在面板左缘右移半个图标宽处，图标因此骑在面板左缘上（实测校准）。
    assert.equal(first.y+icons.size,panelHeight,'首枚下边缘应齐面板底边');
    assert.equal(first.x+icons.size,icons.size/2,'首枚右边缘=面板左缘右移半个图标宽');
    const second=buffIconPosition(icons,panelHeight,1);
    assert.equal(second.x,first.x-icons.step,'后续每枚再向左一个步长');
    assert.equal(second.y,first.y,'同一排，纵向不动');
  }
  assert.equal(buffIconPosition(icons,skin.player.height,3).x,-icons.size/2-3*icons.step);
  for(const name of ['dark-strike','whist','aimed-shot','blood-revenge',
    'bard-of-destruction','dark-sense','deep-breath','magic-insight','mana-recovery','ordination-prayer',
    'shield-of-trust','sniping','storm-of-frenzy-power'])assert.ok(icons.catalog[name],name);
  assert.ok(Object.values(icons.catalog).every(file=>file.startsWith('assets/ui/status/buff-')));
  for(const [name,file] of Object.entries(icons.catalog))assert.ok(shippedImage(file),name);
  assert.equal(buffIconBlinking(31,0),false);assert.equal(buffIconBlinking(30,0),false);
  assert.equal(buffIconBlinking(30,4),true);assert.equal(buffIconBlinking(30,8),false);
  assert.equal(buffIconBlinking(0,4),true);
});

test('status hud content rejects a missing member block or buff icon layout',()=>{
  const member=structuredClone(read('status-hud'));delete member.member;assert.throws(()=>parseStatusHud(member));
  const icons=structuredClone(read('status-hud'));icons.buffIcons.step=0;assert.throws(()=>parseStatusHud(icons),/buffIcons\.step/);
  const inset=structuredClone(read('status-hud'));inset.member.inset.right=inset.member.width;assert.throws(()=>parseStatusHud(inset),/inset/);
  const slots=structuredClone(read('status-hud'));slots.member.slots=[10,10,210];assert.throws(()=>parseStatusHud(slots),/slots/);
});

test('the member column lists every active member except the controlled one',()=>{
  assert.equal(skin.member.slots.length,3,'导出保留原版三个控件槽位');
  assert.deepEqual(memberPanelIds(['player'],'player'),[],'单人时竖排不出现');
  assert.deepEqual(memberPanelIds(['player','a'],'player'),['a']);
  assert.deepEqual(memberPanelIds(['player','a','b'],'player'),['a','b'],'主角操控时佣兵按队伍顺序排在下面');
  assert.deepEqual(memberPanelIds(['player','a','b'],'a'),['player','b'],'切换后原操控者回到竖排，位置跟随队伍顺序');
});

test('the member column stacks below the main panel and never reaches the swap button',()=>{
  const memberHeight=skin.member.height;
  const column=(count:number,limit:number,size=1)=>memberColumnLayout({
    top:0,playerHeight:skin.player.height*size,memberHeight,count,limit,size,columnGap:10*size,rowGap:8*size});
  const three=column(3,228);
  assert.equal(three.tops.length,3);
  assert.ok(three.scale>0&&three.scale<1,'三块时要缩小才能让开切换按钮');
  assert.ok(three.tops[0]!>skin.player.height,'第一块从大面板下缘开始');
  const bottom=three.tops[2]!+memberHeight*three.scale;
  assert.ok(bottom<=228,'最后一块不越过切换按钮上缘');
  // 空间足够时不放大到超过原始尺寸。
  assert.equal(column(1,1000).scale,1);
  // 各种窗口比例下都守住下沿，且等比窗口得到同一比例。
  for(const [limit,size,count] of [[228,1,3],[171,.75,3],[114,.5,2],[130,1,3]] as const){
    const ladder=column(count,limit,size);
    assert.ok(ladder.tops.at(-1)!+memberHeight*size*ladder.scale<=limit+1e-9,`${count} 块在 ${limit} 处越界`);
  }
  assert.equal(column(3,456,2).scale,column(3,228,1).scale,'等比坐标下缩放一致');
});

/**
 * DOM HUD 组件通过 `SceneActivity` 订阅所属场景的生命周期状态；暂停、睡眠、重排与销毁后
 * 回调始终与 `sys.isActive()` 一致，也不会留下过期监听。
 */
test('DOM HUD visibility follows owner pause, wake, resize and destruction', async () => {
  let active = true;
  const events = new Map<string, { callback: () => void; context: unknown }[]>();
  const emit = (name: string) => {
    for (const row of [...(events.get(name) ?? [])]) row.callback.call(row.context);
  };
  const owner = {
    sys: { isActive: () => active },
    events: {
      on(event: string, callback: () => void, context: unknown) {
        const rows = events.get(event) ?? [];
        rows.push({ callback, context });
        events.set(event, rows);
      },
      off(event: string, callback: () => void, context: unknown) {
        events.set(event, (events.get(event) ?? []).filter(r => r.callback !== callback || r.context !== context));
      }
    }
  };
  const { SceneActivity } = await import('../src/ui/hud/scene-activity.ts');
  const activity = new SceneActivity(owner);
  const values: boolean[] = [];
  const unsubscribe = activity.watchVisibility(value => values.push(value));
  assert.deepEqual(values, [true], '登记时立即应用所属场景的状态');
  active = false;
  emit('pause');
  assert.equal(values.at(-1), false, '暂停场景会同时隐藏 DOM 组件');
  activity.layout(960, 640);
  assert.equal(values.at(-1), false, '重排不会让暂停场景的组件重新出现');
  active = true;
  emit('wake');
  assert.equal(values.at(-1), true);
  unsubscribe();
  const count = values.length;
  active = false;
  emit('pause');
  assert.equal(values.length, count, '关闭组件后不再收到场景通知');
  const remaining: boolean[] = [];
  activity.watchVisibility(value => remaining.push(value));
  activity.destroy();
  assert.equal(remaining.at(-1), false);
  assert.equal([...events.values()].reduce((sum, list) => sum + list.length, 0), 0);
});
