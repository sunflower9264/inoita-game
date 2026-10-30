import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { boundedHealth,buffIconBlinking,buffIconPosition,gaugeFillWidth,memberColumnLayout,memberPanelIds,targetNameAnchor,targetNameColor } from '../src/domain/status-hud.ts';
import type { PartySnapshot } from '../src/domain/party.ts';
import type { Hud } from '../src/rendering/hud.ts';
import { parseStatusHud,parseBattle,parseCharacterStats,parseItemCatalog,parseCampaign,parseStoryClasses } from '../src/application/content-validation.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import { Session } from '../src/domain/session.ts';
import type Phaser from 'phaser';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { OverheadStatus } from '../src/rendering/overhead-status.ts';
const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const skin=parseStatusHud(read('status-hud')),battle=parseBattle(read('battle'));

test('native gauge crops full, half, subpixel and empty health without stretching',()=>{
  for(const width of [16,40,212]){
    assert.equal(gaugeFillWidth(100,100,width),width);assert.equal(gaugeFillWidth(50,100,width),width/2);
    assert.equal(gaugeFillWidth(0,100,width),0);assert.equal(gaugeFillWidth(1,1000,width),0);
    assert.equal(gaugeFillWidth(101,100,width),width);assert.equal(gaugeFillWidth(-1,100,width),0);assert.equal(gaugeFillWidth(0,0,width),0);
  }
  assert.equal(boundedHealth(99.9,100),99);assert.equal(boundedHealth(-1,100),0);assert.equal(boundedHealth(999,100),100);
  for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>boundedHealth(value,100));
  for(const part of Object.values(skin.assets))assert.ok(fs.existsSync(new URL(`../public/${part}`,import.meta.url)));
  const missing=structuredClone(skin);delete (missing.assets as Partial<typeof skin.assets>)['target-fill'];assert.throws(()=>parseStatusHud(missing),/target-fill/);
  const bad=structuredClone(skin);bad.target.gauge.fillWidth=1000;assert.throws(()=>parseStatusHud(bad),/超出/);
});

test('overhead bars retain native world-pixel layout, colours and player head anchors',()=>{
  assert.deepEqual(skin.overhead.health,{x:-8,y:-19,width:16,height:2,color:'#28c000'});
  assert.deepEqual(skin.overhead.mana,{x:-8,y:-16,width:16,height:2,color:'#0f7cf9'});
  for(const kind of ['frame','leader'] as const){
    const rect=skin.overhead[kind],png=fs.readFileSync(new URL(`../public/${skin.assets[`overhead-${kind}`]}`,import.meta.url));
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
    'bard-of-destruction','dark-sense','deep-breath','magic-insight','ordination-prayer',
    'shield-of-trust','sniping','storm-of-frenzy-power'])assert.ok(icons.catalog[name],name);
  assert.ok(Object.values(icons.catalog).every(file=>file.startsWith('assets/ui/status/buff-')));
  for(const [name,file] of Object.entries(icons.catalog))assert.ok(fs.existsSync(new URL(`../public/${file}`,import.meta.url)),name);
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
 * 佣兵面板的容器登记在 Hud 的可见性表里。谁绕过 `hud.setVisible` 直接改容器，表里就停在旧值，
 * 下一次重排（切图重建、旋转、从后台回来都会走到 `Hud.refresh`）会把旧值贴回去——表现为
 * 剧情演出、对白和菜单期间本该隐藏的佣兵面板又冒出来，而且一直留到演出结束。
 */
test('member panels hide and return only through the HUD registry', async () => {
  class Node {
    x=0;y=0;width=0;height=0;visible=true;scaleX=1;scaleY=1;list:Node[]=[];style?:{color?:string;fontSize?:number};
    setOrigin(){return this;}setDisplaySize(){return this;}setSize(){return this;}
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;}setX(x:number){this.x=x;return this;}
    setScale(x:number,y=x){this.scaleX=x;this.scaleY=y;return this;}
    setVisible(value:boolean){this.visible=value;return this;}
    setTexture(){return this;}setCrop(){return this;}setText(){return this;}
    setColor(value:string){if(this.style)this.style.color=value;return this;}
    setData(){return this;}getData(){return undefined;}
    setInteractive(){return this;}disableInteractive(){return this;}on(){return this;}
    add(child:Node|Node[]){for(const value of Array.isArray(child)?child:[child])this.list.push(value);return this;}
    destroy(){}
  }
  const node=(x=0,y=0)=>Object.assign(new Node(),{x,y});
  const text=(x=0,y=0,_value='',style?:{color?:string;fontSize?:number})=>Object.assign(node(x,y),{style});
  const scene={
    add:{container:node,image:node,text},
    textures:{get:()=>({setFilter(){}}),exists:()=>true},
    game:{canvas:{getBoundingClientRect:()=>({x:0,y:0,width:1024,height:640})}},
    scale:{width:1024,height:640},
  };
  // 真实 Hud 在这里只需要两件事：登记可见性，以及重排时把登记值贴回对象。
  const registered:Node[]=[],desired=new Map<Node,boolean>();
  const hud={
    scene,
    add:(object:Node)=>{registered.push(object);desired.set(object,object.visible);return object;},
    setVisible:(object:Node,visible:boolean)=>{desired.set(object,visible);object.setVisible(visible);},
    refresh:()=>{for(const [object,visible] of desired)object.setVisible(visible);},
  };
  const previous=Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    document: { value: { getElementById: (id:string) => id === 'safe-area' ? {} : null }, configurable: true },
    getComputedStyle: { value: () => ({ paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0' }), configurable: true },
  });
  const hook=registerHooks({resolve(specifier,context,next){
    return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(
      'export default {BlendModes:{ADD:1},Geom:{Rectangle:class{static Contains(){return true;}}},Textures:{FilterMode:{LINEAR:1}}};'
    )}`}:next(specifier,context);
  }});
  try {
    const { StatusHud } = await import('../src/ui/phaser/status-hud.ts');
    const player={level:1,health:100,maxHealth:100,mana:50,maxMana:100,experience:0,nextLevelExperience:100};
    const party=()=>({active:['player','mercenary'],living:['player','mercenary'],rosterSlots:[null],reserves:[],
      controlled:'player',members:[{id:'mercenary',...player}]}) as unknown as PartySnapshot;
    const status=new StatusHud(hud as unknown as Hud,skin,()=>player,()=>()=>{},party);
    // 前两个登记项是大面板与目标面板，其余都是队友面板。
    const panels=registered.slice(2);
    assert.equal(panels.length,skin.member.slots.length,'队友面板全部登记在 Hud 里');
    // 只有第一块有队员，其余是空槽。
    status.setTarget({id:'enemy',name:'狼',level:9,health:10,maxHealth:10,sceneLevel:false});
    const targetName=registered[1]!.list.find(value=>value.style?.fontSize===18);
    assert.equal(targetName?.style?.color,'#9c00ff','等级差颜色保持原版');
    status.setTarget({id:'weak',name:'弱敌',level:-7,health:10,maxHealth:10,sceneLevel:false});
    assert.equal(targetName?.style?.color,'#ffffff','低 8 级以上的灰色改为白色');
    status.setVisible(true);
    assert.equal(panels[0]!.visible,true,'有队员时队友面板显示');
    hud.refresh();
    assert.equal(panels[0]!.visible,true,'重排后仍然显示');
    status.setVisible(false);
    assert(panels.every(panel=>!panel.visible),'演出、对白和菜单期间队友面板隐藏');
    hud.refresh();
    assert(panels.every(panel=>!panel.visible),'重排后队友面板不会冒出来');
  } finally {
    hook.deregister();
    Object.defineProperties(globalThis, {
      document: { ...previous.document, configurable: true },
      getComputedStyle: { ...previous.getComputedStyle, configurable: true },
    });
  }
});
