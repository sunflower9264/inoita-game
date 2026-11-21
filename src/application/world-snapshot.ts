import type { TravelDestination, EntityPlacement } from '../domain/content.ts';
import type { WorldCombatState } from '../domain/combat-snapshot.ts';
import type { SceneSnapshot } from '../domain/scene-snapshot.ts';
import type { StoryAudioState } from './game-audio.ts';

/** 世界现场的数据契约；画面对象和场景实例不进入快照。 */
export interface StoryWorldViewSnapshot {
  location:TravelDestination;
  world?:WorldCombatState;
  generatedEntities:EntityPlacement[];
  triggerContacts?:{ regions:string[]; characters:string[]; nearEvents:string[] };
  scene?:SceneSnapshot;
  audio?:StoryAudioState;
}
export type SaveWorldReason = 'pressure' | 'loading' | 'not-ready' | 'no-survivors';
export type SaveWorldResult =
  | { ok:true; map:{id:string;name:string}; world:StoryWorldViewSnapshot }
  | { ok:false; reason:SaveWorldReason };
