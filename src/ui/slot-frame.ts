import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { ItemInstance } from '../domain/items.ts';
import { equipmentSlotFrame } from './item-name-color.ts';

/**
 * 背包与队伍页的格子底图：装备按品质换边框图，其它道具沿用默认格子。
 * 取色口径与物品说明标题一致（`equipmentSlotFrame`）。
 */
export function slotFrameImage(app: StoryUIContext, session: Session, entry: ItemInstance | undefined): string {
  const fallback = app.menuPanels.assets['inventory-slot'];
  if (!entry) return fallback;
  const key = equipmentSlotFrame(session.bag.catalog.items[entry.item], entry.numbers,
    app.characterStats.equipment[entry.item], app.shops.grades);
  return (key ? app.menuPanels.assets[key] : undefined) || fallback;
}

/** 小锁独立于品质边框，复用节点以支持背包局部更新。 */
export function updateEquipmentLock(v:import('./dom/surface.ts').UiSurface,parent:import('./dom/node.ts').UiNode,locked:boolean):void {
  let mark=parent.getData('equipment-lock') as import('./dom/node.ts').UiNode|undefined;
  if(!mark&&locked){
    mark=v.rect(52,1,21,24,0x17120a,1,parent);parent.setData('equipment-lock',mark);
    v.rect(6,3,10,10,0xe2cb9e,1,mark);v.rect(8,5,6,7,0x17120a,1,mark);
    v.rect(4,11,14,11,0xe2cb9e,1,mark);v.rect(10,14,2,5,0x17120a,1,mark);
  }
  mark?.setVisible(locked);
}
