import test from 'node:test';
import assert from 'node:assert/strict';
import { drawRoundBand } from '../src/ui/panels/round-band.ts';
import { drawSolidBorder } from '../src/ui/panels/solid-border.ts';

type Box = { x:number; y:number; width:number; height:number };
class Node {
  setAlpha(){return this;} setFlipX(){return this;} setFlipY(){return this;}
}
/**
 * 只记每块绘制的矩形。这两个函数都是九宫格拼图：五块（或四角加两条横条）拼完要正好铺满目标
 * 矩形，漏掉一块就会透出后面的画面——人物页那条灰底少了底边、技能页标题条少了下半条横条，
 * 都出在这里，所以按「有没有漏画的地方」而不是按逐块坐标写断言。
 */
class Surface {
  boxes:Box[]=[];
  image(_file:string,x:number,y:number,width:number,height:number){this.boxes.push({x,y,width,height});return new Node();}
  rect(x:number,y:number,width:number,height:number){this.boxes.push({x,y,width,height});return new Node();}
}
const assets:Record<string,string>=Object.fromEntries(['round-nw','round-ne','round-sw','round-se',
  'solid-nw','solid-ne','solid-sw','solid-se','solid-edge'].map(key=>[key,key]));
/** 矩形里没被任何一块盖住的像素点，逐点采样。 */
const gaps=(boxes:Box[],x:number,y:number,width:number,height:number):string[]=>{
  const missing:string[]=[];
  for(let py=y;py<y+height;py++)for(let px=x;px<x+width;px++)
    if(!boxes.some(box=>px>=box.x&&px<box.x+box.width&&py>=box.y&&py<box.y+box.height))missing.push(`${px},${py}`);
  return missing.length>3?[...missing.slice(0,3),`…共 ${missing.length} 点`]:missing;
};

test('压暗的圆角带铺满整个矩形',()=>{
  // 人物页左栏「能力点／技能点」那条：(118,202,343,34)，强度 80。
  const surface=new Surface();
  drawRoundBand(surface as never,assets,118,202,343,34,80);
  assert.deepEqual(gaps(surface.boxes,118,202,343,34),[],'底边与左边条都不能漏');
});

test('圆角带在属性行与佣兵页的尺寸上也铺满',()=>{
  for(const [width,height] of [[190,48],[364,48],[341,101]] as const){
    const surface=new Surface();
    drawRoundBand(surface as never,assets,513,75,width,height,50);
    assert.deepEqual(gaps(surface.boxes,513,75,width,height),[],`${width}×${height} 有一条没画到`);
  }
});

test('实心条边框的横条与四角接上',()=>{
  // 技能页右上「技能点」栏与人物页「能力点」条都是 53 高（四角 27 + 26）。
  const surface=new Surface();
  drawSolidBorder(surface as never,assets,537,0,409,53);
  assert.deepEqual(gaps(surface.boxes,537,0,409,53),[],'横条要按四角高度铺满，中间不能留缝');
});
