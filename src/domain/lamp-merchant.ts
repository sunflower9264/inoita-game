import type { EntityPlacement } from './content.ts';
import type { Session } from './session.ts';

/** 一枚神灯对应一个本次进图的商人，扣道具和创建实体一起提交。 */
export function summonLampMerchant(session:Session,entry:string,entity:EntityPlacement & {map:string}):void {
  const item=session.bag.get(entry);
  if(!item||session.bag.catalog.items[item.item].use?.kind!=='merchant')throw new Error('请选择背包中的神灯');
  if(!entity.map||session.storyWorld.currentLocation?.map!==entity.map)throw new Error('当前地图已变化');
  if(session.storyWorld.entity(entity.id))throw new Error('商人已经存在');
  session.atomic(()=>{
    session.storyWorld.apply({kind:'place',scope:'visit',entity:{...entity,authority:'npc',visible:true}});
    session.bag.use(entry);
  },['bag','storyWorld']);
}
