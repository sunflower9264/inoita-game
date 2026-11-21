/** 每名角色首次触发狂气后，换装会更新已找到的动画长度；缺少动画时保留上一次长度。 */
export class FrenzyAnimationMemory {
  private readonly frames = new Map<string,number>();

  select(actorId:string,animationFrames:number|undefined,initialWaitFrames:number):number {
    const frames=animationFrames??this.frames.get(actorId)??initialWaitFrames;
    this.frames.set(actorId,frames);
    return frames;
  }

  updateEquipment(actorId:string,animationFrames:number|undefined):void {
    if(this.frames.has(actorId)&&animationFrames!==undefined)this.frames.set(actorId,animationFrames);
  }

  removeActor(actorId:string):void { this.frames.delete(actorId); }

  checkpointActor(actorId:string):()=>void {
    const frames=this.frames.get(actorId);
    return ()=>{if(frames===undefined)this.frames.delete(actorId);else this.frames.set(actorId,frames);};
  }
  captureState():[string,number][] { return [...this.frames]; }
  restoreState(state:readonly (readonly [string,number])[]):void {
    this.frames.clear();
    for(const [id,frames]of state)this.frames.set(id,frames);
  }
}
