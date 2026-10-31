import type { Session, SessionState } from './session.ts';

interface CheckpointLocation { map:string; x:number; y:number }
interface CheckpointSnapshot<WorldState> { session:SessionState; location:CheckpointLocation; world:WorldState }

/** One in-memory checkpoint. Scene code supplies only its explicit, serializable world state. */
export class SessionCheckpoint<WorldState = undefined> {
  private snapshot?:CheckpointSnapshot<WorldState>;
  get available():boolean { return !!this.snapshot; }
  peek():CheckpointSnapshot<WorldState>|undefined { return this.snapshot?structuredClone(this.snapshot):undefined; }
  capture(session:Session,location:CheckpointLocation,world:WorldState):void {
    const state=session.captureState();
    // 已拔出的古老武器是存档级进度；死亡检查点不回滚它，否则同一存档能反复拔同一把剑。
    delete state.legendaryWeapons;
    this.snapshot=structuredClone({session:state,location,world});
  }
  restore(session:Session):{location:CheckpointLocation;world:WorldState}|undefined {
    if(!this.snapshot)return;
    const restored=structuredClone(this.snapshot);
    session.restoreState(restored.session);
    return {location:restored.location,world:restored.world};
  }
  clear():void { this.snapshot=undefined; }
}
