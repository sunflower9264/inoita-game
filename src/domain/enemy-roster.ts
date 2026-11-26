import { boundedHealth, type TargetStatus } from './status-hud.ts';
import { calculateEnemy, enemyPartySize, type EnemySnapshot } from './enemy-stats.ts';
import type { PlacedEnemy, EnemyDefinition } from './battle.ts';

type CalculatedEnemyStats=ReturnType<typeof calculateEnemy>;

/** 稳定派生属性：定义、等级、精英、队伍人数、主角/场景等级、血量覆盖和召唤覆盖都没变时复用。 */
interface EnemyStatsEntry {
  definition:EnemyDefinition;
  level:number|undefined;
  elite:boolean|undefined;
  partySize:number;
  playerLevel:number;
  sceneLevel:number;
  overrideMaxHealth:number|undefined;
  summonedStats:PlacedEnemy['summonedStats'];
  stats:CalculatedEnemyStats;
}

/** 血蓝上限只随定义、等级、精英、队伍人数、血量覆盖和召唤覆盖变化。 */
interface EnemyLimitsEntry {
  definition:EnemyDefinition;
  level:number|undefined;
  elite:boolean|undefined;
  partySize:number;
  overrideMaxHealth:number|undefined;
  summonedStats:PlacedEnemy['summonedStats'];
  maxHealth:number;
  maxMana:number;
}

/** 完整快照复用稳定属性，并把本次生效的血蓝写进缓存键。 */
interface EnemySnapshotEntry {
  stats:EnemyStatsEntry;
  health:number;
  mana:number;
  snapshot:Readonly<EnemySnapshot>;
}

/** 管理地图敌人及召唤物的实例状态。 */
export class EnemyRoster {
  enemies: PlacedEnemy[] = [];
  /** 按实例 key 索引；生成、恢复、移除和整份恢复时同步维护。 */
  private readonly byKey = new Map<string,PlacedEnemy>();
  /** 原始血量正好为 0 的实例；选敌查询走这个集合，不再逐敌 find 全名单。 */
  private readonly zeroHealth = new Set<string>();
  private readonly statsCache = new Map<string,EnemyStatsEntry>();
  private readonly limitsCache = new Map<string,EnemyLimitsEntry>();
  private readonly snapshotCache = new Map<string,EnemySnapshotEntry>();
  private enemySeq = 0;
  private currentPartySize = 1;
  private enemyListeners = new Set<()=>void>();
  get partySize():number { return this.currentPartySize; }
  captureState():{enemies:PlacedEnemy[];sequence:number;partySize:number}{
    return {enemies:structuredClone(this.enemies),sequence:this.enemySeq,partySize:this.currentPartySize};
  }
  restoreState(state:{enemies:PlacedEnemy[];sequence:number;partySize:number}):void{
    this.enemies=structuredClone(state.enemies);this.enemySeq=state.sequence;this.currentPartySize=state.partySize;
    this.rebuildIndex();this.clearCaches();
    this.zeroHealth.clear();
    for(const enemy of this.enemies)if(enemy.health===0)this.zeroHealth.add(enemy.key);
    this.notifyEnemies();
  }
  subscribeEnemies(listener:()=>void):()=>void { this.enemyListeners.add(listener);return ()=>{this.enemyListeners.delete(listener);}; }
  private notifyEnemies():void { for(const listener of this.enemyListeners)listener(); }
  private rebuildIndex():void {
    this.byKey.clear();
    for(const enemy of this.enemies)this.byKey.set(enemy.key,enemy);
  }
  private forgetCaches(key:string):void {
    this.statsCache.delete(key);this.limitsCache.delete(key);this.snapshotCache.delete(key);
  }
  private clearCaches():void {
    this.statsCache.clear();this.limitsCache.clear();this.snapshotCache.clear();
  }
  private trackZeroHealth(key:string,health:number|undefined):void {
    if(health===0)this.zeroHealth.add(key);else this.zeroHealth.delete(key);
  }
  /** 按实例 key 取名册条目；未登记时返回 undefined。 */
  enemy(key:string):PlacedEnemy|undefined { return this.byKey.get(key); }
  /** 登记一个敌人并分配实例标识。 */
  placeEnemy(enemyId: string, x: number, y: number): PlacedEnemy {
    const placed: PlacedEnemy = { key: `enemy-${++this.enemySeq}`, enemyId, x, y };
    this.forgetCaches(placed.key);
    this.enemies.push(placed);this.byKey.set(placed.key,placed);this.notifyEnemies();return placed;
  }
  /** Restore a world spawn with its stable instance key and saved resources. */
  restoreEnemy(placed:PlacedEnemy):void {
    if(this.byKey.has(placed.key))return;
    const stored={...placed};
    this.forgetCaches(stored.key);
    this.enemies.push(stored);this.byKey.set(stored.key,stored);
    this.trackZeroHealth(stored.key,stored.health);
    this.notifyEnemies();
  }
  /** 移出名单；外观由场景负责销毁。 */
  removeEnemy(key: string): void {
    this.zeroHealth.delete(key);
    if(!this.byKey.has(key))return;
    this.byKey.delete(key);this.forgetCaches(key);
    this.enemies = this.enemies.filter(enemy => enemy.key !== key);this.notifyEnemies();
  }
  /** 更新站位或召唤落点。 */
  moveEnemy(key: string, x: number, y: number): void {
    const placed = this.byKey.get(key);
    if (placed) { placed.x = x; placed.y = y; }
  }
  /** 稳定派生属性按缓存键复用；当前血蓝不进入这层缓存。 */
  private stableStats(key:string,definition:EnemyDefinition,placed:PlacedEnemy,playerLevel:number,sceneLevel:number):EnemyStatsEntry {
    const cached=this.statsCache.get(key);
    if(cached&&cached.definition===definition&&cached.level===placed.level&&cached.elite===placed.elite&&
      cached.partySize===this.partySize&&cached.playerLevel===playerLevel&&cached.sceneLevel===sceneLevel&&
      cached.overrideMaxHealth===placed.overrideMaxHealth&&cached.summonedStats===placed.summonedStats)return cached;
    const calculated=calculateEnemy(definition,{level:placed.level,elite:placed.elite,partySize:this.partySize,playerLevel,sceneLevel});
    // 召唤物的派生属性覆盖自身数据里的对应项，挑战调试可再覆盖最大血量。
    const withSummon=placed.summonedStats?{...calculated,...placed.summonedStats}:calculated;
    const stats=placed.overrideMaxHealth!==undefined
      ?Object.freeze({...withSummon,maxHealth:placed.overrideMaxHealth})
      :(placed.summonedStats?Object.freeze(withSummon):calculated);
    const entry:EnemyStatsEntry={definition,level:placed.level,elite:placed.elite,partySize:this.partySize,
      playerLevel,sceneLevel,overrideMaxHealth:placed.overrideMaxHealth,summonedStats:placed.summonedStats,stats};
    this.statsCache.set(key,entry);return entry;
  }
  /** 生命/法力上限的缓存；只按影响上限的输入失效。 */
  private healthLimits(key:string,definition:EnemyDefinition,placed:PlacedEnemy):EnemyLimitsEntry {
    const cached=this.limitsCache.get(key);
    if(cached&&cached.definition===definition&&cached.level===placed.level&&cached.elite===placed.elite&&
      cached.partySize===this.partySize&&cached.overrideMaxHealth===placed.overrideMaxHealth&&
      cached.summonedStats===placed.summonedStats)return cached;
    const calculated=calculateEnemy(definition,{level:placed.level,elite:placed.elite,partySize:this.partySize});
    const entry:EnemyLimitsEntry={definition,level:placed.level,elite:placed.elite,partySize:this.partySize,
      overrideMaxHealth:placed.overrideMaxHealth,summonedStats:placed.summonedStats,
      maxHealth:placed.overrideMaxHealth??placed.summonedStats?.maxHealth??calculated.maxHealth,maxMana:calculated.maxMana};
    this.limitsCache.set(key,entry);return entry;
  }
  enemySnapshot(key:string,definition:EnemyDefinition,playerLevel=1,sceneLevel=1):Readonly<EnemySnapshot>|undefined {
    const placed=this.byKey.get(key);
    if(!placed||placed.enemyId!==definition.id)return;
    const stable=this.stableStats(key,definition,placed,playerLevel,sceneLevel);
    const health=boundedHealth(placed.health??stable.stats.maxHealth,stable.stats.maxHealth);
    const mana=boundedHealth(placed.mana??stable.stats.maxMana,stable.stats.maxMana);
    const cached=this.snapshotCache.get(key);
    // 血蓝取当前实例值参与比较，同一逻辑帧连续命中/治疗后不会复用旧快照。
    if(cached?.stats===stable&&cached.health===health&&cached.mana===mana)return cached.snapshot;
    const snapshot=Object.freeze({...stable.stats,id:key,name:definition.name,health,mana});
    this.snapshotCache.set(key,{stats:stable,health,mana,snapshot});return snapshot;
  }
  enemyStatus(key:string,definition:EnemyDefinition,sceneLevel=1):TargetStatus|undefined {
    const snapshot=this.enemySnapshot(key,definition,1,sceneLevel);
    if(!snapshot)return;
    const {id,name,level,sceneLevel:usesSceneLevel,health,maxHealth}=snapshot;
    return {id,name,level,sceneLevel:usesSceneLevel,health,maxHealth,specialRank:definition.specialRank??0};
  }
  /** 原始血量是否正好为 0；未写入过血量表示满血。 */
  hasZeroHealth(key:string):boolean {
    return this.zeroHealth.has(key);
  }
  setEnemyHealth(key:string,value:number,definition:EnemyDefinition):void {
    const placed=this.byKey.get(key);
    if(!placed||placed.enemyId!==definition.id)return;
    const limits=this.healthLimits(key,definition,placed);
    const health=boundedHealth(value,limits.maxHealth);
    if(health===boundedHealth(placed.health??limits.maxHealth,limits.maxHealth)){this.trackZeroHealth(key,health);return;}
    placed.health=health;this.trackZeroHealth(key,health);this.notifyEnemies();
  }
  /** 设定或清除最大血量覆盖，并按新上限回满活着的敌人（0 血待结算怪保持不变）。 */
  setEnemyMaxHealthOverride(key:string,maxHealth:number|undefined,definition:EnemyDefinition):void {
    const placed=this.byKey.get(key);
    if(!placed||placed.enemyId!==definition.id)return;
    placed.overrideMaxHealth=maxHealth===undefined?undefined:Math.max(1,Math.trunc(maxHealth));
    this.forgetCaches(key);
    if(!this.zeroHealth.has(key)){
      const limits=this.healthLimits(key,definition,placed);
      placed.health=limits.maxHealth;
      this.trackZeroHealth(key,placed.health);
    }
    this.notifyEnemies();
  }
  setEnemyMana(key:string,value:number,definition:EnemyDefinition):void {
    const placed=this.byKey.get(key);
    if(!placed||placed.enemyId!==definition.id)return;
    const limits=this.healthLimits(key,definition,placed);
    const mana=boundedHealth(value,limits.maxMana);
    if(mana===boundedHealth(placed.mana??limits.maxMana,limits.maxMana))return;
    placed.mana=mana;this.notifyEnemies();
  }
  setPartySize(size:number,definitions:readonly EnemyDefinition[]):void {
    enemyPartySize(size);if(size===this.partySize)return;
    // 先准备全部结果，再一次性写入，订阅者读到的队伍和生命上限保持一致。
    const changes=this.enemies.map(placed=>{
      const definition=definitions.find(enemy=>enemy.id===placed.enemyId);
      if(!definition)throw new Error(`怪物内容缺失：${placed.enemyId}`);
      const before=this.enemySnapshot(placed.key,definition)!;
      const after=calculateEnemy(definition,{level:placed.level,elite:placed.elite,partySize:size});
      const maxHealth=placed.overrideMaxHealth??placed.summonedStats?.maxHealth??after.maxHealth;
      const minimumHealth=before.health>0?1:0;
      return {placed,health:placed.health===undefined?undefined:
        Math.max(minimumHealth,Math.trunc(before.health*maxHealth/before.maxHealth))};
    });
    this.currentPartySize=size;this.clearCaches();
    for(const {placed,health} of changes){placed.health=health;this.trackZeroHealth(placed.key,health);}
    this.notifyEnemies();
  }
}
