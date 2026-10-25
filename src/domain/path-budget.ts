/**
 * 每渲染帧共享的寻路扩展预算。
 *
 * 一次 A* 扩展要查地形和人物占位；几十个敌人各自同步跑完会叠成尖峰。
 * 所有 AI 从这里领预算，领完就等下一渲染帧，成本跟“这一帧能算多少”走，
 * 而不是跟“这一帧有多少个 AI 想算路”走。
 */
export class PathBudget {
  readonly perFrame:number;
  private remaining:number;
  constructor(perFrame:number){this.perFrame=perFrame;this.remaining=perFrame;}
  reset():void{this.remaining=this.perFrame;}
  get left():number{return this.remaining;}
  /** 领取最多 `limit` 个扩展；返回 0 表示这一帧不再开始/推进搜索。 */
  take(limit:number):number{
    const granted=Math.max(0,Math.min(limit,this.remaining));
    this.remaining-=granted;
    return granted;
  }
}
