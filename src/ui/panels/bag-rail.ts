import { BAG_OUTER_FRAME, BAG_RAIL } from '../bag-layout.ts';
import type { UiNode } from '../dom/node.ts';
import type { UiSurface } from '../widgets.ts';

/** 背包右框与分类栏共用同一套几何；商店整体向左平移。 */
export function drawBagRail(v:UiSurface,assets:Record<string,string>,x=496,parent?:UiNode):void {
  const dx=x-BAG_OUTER_FRAME.x;
  v.border(assets,x,BAG_OUTER_FRAME.y,BAG_OUTER_FRAME.width,BAG_OUTER_FRAME.height,parent);
  v.rect(BAG_RAIL.dividerX+dx,BAG_RAIL.y,1,BAG_RAIL.height,0x6b5a37,.8,parent);
  v.rect(BAG_RAIL.x+dx,BAG_RAIL.y,BAG_RAIL.width,BAG_RAIL.height,0x000000,.35,parent);
  for(let index=0;index<6;index++)
    v.rect(BAG_RAIL.x+dx,BAG_RAIL.rowTop+index*BAG_RAIL.rowStep+BAG_RAIL.rowHeight-1,
      BAG_RAIL.width,1,0x6b5a37,.5,parent);
}
