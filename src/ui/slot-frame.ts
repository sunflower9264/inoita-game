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
