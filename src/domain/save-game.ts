import type { Session, SessionState } from './session.ts';

/** 手动存档槽：原版三个，体验版扩到十个，方便反复测任务时保进度。 */
export const MANUAL_SAVE_SLOT_COUNT = 10;
/**
 * 存档格式版本。记录结构或校验口径变了就加一，并在 `application/saved-game.ts`
 * 的升级链里补上从上一版读回的迁移；比 `LEGACY_SAVE_FORMATS` 更旧的档才按空槽处理。
 */
export const SAVE_FORMAT = 53;
/** 仍然能读回并升级到当前格式的旧版本；新增升级步骤时同步加入这里。 */
export const LEGACY_SAVE_FORMATS: readonly number[] = [52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33];
export function isReadableSaveFormat(format: unknown): format is number {
  return typeof format === 'number' && (format === SAVE_FORMAT || LEGACY_SAVE_FORMATS.includes(format));
}

/** 云存档导入时的格式分类：能读、比当前新、比升级链旧、版本不合法。 */
type SaveFormatStatus = 'ok' | 'future' | 'obsolete' | 'unknown';
export function saveFormatStatus(format: unknown): SaveFormatStatus {
  if (typeof format !== 'number' || !Number.isSafeInteger(format)) return 'unknown';
  if (isReadableSaveFormat(format)) return 'ok';
  return format > SAVE_FORMAT ? 'future' : 'obsolete';
}

/** 存档写给谁：手动槽用序号（0..9），唯一的自动槽用 `'auto'`。 */
export type SaveSlotRef = number | typeof AUTO_SAVE_SLOT;
export const AUTO_SAVE_SLOT = 'auto';
/** 界面上的默认叫法；自定义名字在 `SaveSummary.name`。 */
export function saveSlotLabel(ref:SaveSlotRef):string {
  return ref===AUTO_SAVE_SLOT ? '自动存档' : `存档槽 ${ref+1}`;
}

/**
 * 存档槽里显示的一行摘要。职业名、地图名和立绘路径在**存档时**就展开：标题页读档只要这份摘要
 * 加一张立绘，不必先把整个世界目录和职业目录加载起来。
 *
 * `name` 是玩家改的名字（只允许中文、英文、数字）；`savedAt` 是写入时刻，标题页与存档页显示。
 */
export interface SaveSummary {
  classId:string; className:string; portrait:string;
  level:number;
  mapId:string; mapName:string;
  name?:string;
  savedAt?:number;
  /** 保存时游戏画面的缩略图（JPEG data URL）。旧存档没有这个字段，界面不画图片。 */
  screenshot?:string;
}

/** 一份存档：会话状态加世界视图（地图、落点、战斗与剧情实体、音频）。 */
export interface SaveGame<World = unknown> {
  format:number;
  summary:SaveSummary;
  session:SessionState;
  world:World;
}

/**
 * 读一个槽的三种结果。`unreadable` 与 `empty` 分开：损坏槽保留 unreadable，保存覆盖时确认；开发阶段的版本不符槽显示 EMPTY。
 */
type SlotReading<World = unknown> =
  | { kind:'empty' }
  | { kind:'unreadable'; reason:string }
  | { kind:'ok'; game:SaveGame<World> };

/** 只带摘要的读槽结果：存档页显示用，不必把整份存档留在内存里。 */
export type SlotSummaryReading =
  | { kind:'empty' }
  | { kind:'unreadable'; reason:string }
  | { kind:'ok'; summary:SaveSummary };

/**
 * 云端导入用的原始读档结果。与 `SlotSummaryReading` 不同：这里把“未来版本”和
 * “升级链之前的旧版本”分开，界面能在上传/下载前告诉玩家具体原因，而不是混成空槽。
 */
export type SaveRawReading =
  | { kind:'ok'; raw:string; summary:SaveSummary; format:number }
  | { kind:'empty' }
  | { kind:'future'; reason:string }
  | { kind:'obsolete'; reason:string }
  | { kind:'unreadable'; reason:string };

/** 存档要用的那部分 localStorage；测试传内存实现。 */
export interface SaveStorage {
  getItem(key:string):string|null;
  setItem(key:string,value:string):void;
  removeItem(key:string):void;
}

/** 存档名字的最大长度（按字符计）。 */
export const SAVE_NAME_MAX_LENGTH = 12;

/**
 * 存档名字只保留中文、英文和数字。`value` 里其他字符直接去掉，超长截断；
 * 全部被过滤掉时返回空串，调用方据此清掉自定义名字、回退到「存档槽 N」。
 */
export function sanitizeSaveName(value:string):string {
  const kept=[...value].filter(character=>/[㐀-䶿一-鿿豈-﫿A-Za-z0-9]/.test(character)).join('');
  return kept.slice(0,SAVE_NAME_MAX_LENGTH);
}

/** 会话当前的职业：故事会话取自职业设定，没有职业设定的会话（如菜单测试）取自战斗角色。 */
export function sessionClassId(session:Session):string|undefined {
  return session.character?.classId ?? session.hero?.classId;
}

export function saveSummary(session:Session, map:{id:string;name:string},
  storyClass:{name:string;portrait:string}, screenshot?:string):SaveSummary {
  const classId=sessionClassId(session);
  if(!classId)throw new Error('存档缺少职业');
  return { classId, className:storyClass.name, portrait:storyClass.portrait,
    level:session.player?.level ?? 1, mapId:map.id, mapName:map.name,
    ...(screenshot ? { screenshot } : {}) };
}

export function captureSaveGame<World>(session:Session, world:World, summary:SaveSummary):SaveGame<World> {
  return { format:SAVE_FORMAT, summary:{ ...summary, savedAt:Date.now() }, session:session.capturePersistentState(), world };
}

/** 把存档灌回一个同职业的新会话。校验全部交给 `Session.restoreState`：它对背包、技能、任务、队伍逐项验。 */
export function restoreSaveGame<World>(session:Session, game:SaveGame<World>):World {
  session.restoreState(game.session);
  // 校验通过后再收拢：旧档里分散的同 id 可叠加实例并成一条；数量非法仍在上一行按原规则报错。
  session.bag.mergeStackedInstances();
  return game.world;
}

/**
 * 手动槽与自动槽的本地持久化。手动键形如 `inotia4.story.v1.slot0`，自动槽是
 * `inotia4.story.v1.auto`，与音频设置 `inotia4.audio.v1` 同一套命名。
 */
export class SaveSlots<World = unknown> {
  private readonly storage:SaveStorage;
  private readonly prefix:string;
  /** 按原始字符串缓存的摘要；存档页反复读同一批槽时只解析一次。 */
  private readonly summaryCache=new Map<string,{raw:string;reading:SlotSummaryReading}>();
  constructor(storage?:SaveStorage, prefix='inotia4.story.v1') {
    this.storage=storage ?? (typeof localStorage==='undefined' ? noStorage : localStorage);
    this.prefix=prefix;
  }
  private key(ref:SaveSlotRef):string {
    if(ref===AUTO_SAVE_SLOT)return `${this.prefix}.auto`;
    const slot=ref;
    if(!Number.isSafeInteger(slot)||slot<0||slot>=MANUAL_SAVE_SLOT_COUNT)throw new Error('存档槽编号无效');
    return `${this.prefix}.slot${slot}`;
  }
  /** 删除与改名只对手动槽开放；自动槽是固定的一格，界面也不会给出入口。 */
  private manualKey(ref:SaveSlotRef):string {
    if(ref===AUTO_SAVE_SLOT)throw new Error('自动存档不能删除或改名');
    return this.key(ref);
  }
  /**
   * 只读摘要：标题页/存档页显示用。解析结果按原始字符串缓存，存档没变就不重复 parse；
   * 要整份存档（真正读档）仍用 `inspect`。
   */
  peek(ref:SaveSlotRef):SlotSummaryReading {
    const key=this.key(ref);
    let raw:string|null;
    try { raw=this.storage.getItem(key); }
    catch { return {kind:'unreadable',reason:'无法读取本地存档'}; }
    if(raw===null){this.summaryCache.delete(key);return {kind:'empty'};}
    const cached=this.summaryCache.get(key);
    if(cached&&cached.raw===raw)return cached.reading;
    const reading=this.summaryOf(raw);
    this.summaryCache.set(key,{raw,reading});
    return reading;
  }
  private summaryOf(raw:string):SlotSummaryReading {
    let parsed:unknown;
    try { parsed=JSON.parse(raw); }
    catch { return {kind:'unreadable',reason:'存档内容不是有效 JSON'}; }
    return this.summaryReadingOf(parsed as Partial<SaveGame<World>>);
  }
  /** 已解析记录的摘要判定；peek、inspect 和写档回填缓存共用，避免三处条件分叉。 */
  private summaryReadingOf(record:Partial<SaveGame<World>>):SlotSummaryReading {
    if(!record||typeof record!=='object')return {kind:'unreadable',reason:'存档内容不是对象'};
    if(typeof record.format==='number'&&!isReadableSaveFormat(record.format))return {kind:'empty'};
    if(!isReadableSaveFormat(record.format))return {kind:'unreadable',reason:'存档缺少有效版本'};
    if(!record.session||!record.world)return {kind:'unreadable',reason:'存档缺少会话或世界状态'};
    const summary=record.summary;
    if(!summary||typeof summary.classId!=='string'||typeof summary.mapId!=='string'||!Number.isFinite(summary.level))
      return {kind:'unreadable',reason:'存档摘要无效'};
    return {kind:'ok',summary};
  }
  inspect(ref:SaveSlotRef):SlotReading<World> {
    const key=this.key(ref);
    let raw:string|null;
    try { raw=this.storage.getItem(key); }
    catch { return {kind:'unreadable',reason:'无法读取本地存档'}; }
    if(raw===null)return {kind:'empty'};
    let parsed:unknown;
    try { parsed=JSON.parse(raw); }
    catch { return {kind:'unreadable',reason:'存档内容不是有效 JSON'}; }
    const record=parsed as Partial<SaveGame<World>>;
    const reading=this.summaryReadingOf(record);
    return reading.kind==='ok'?{kind:'ok',game:record as SaveGame<World>}:reading;
  }
  /**
   * 云端上传前读原始 JSON。有效档原样返回；未来/过旧/损坏分别给出原因，
   * 调用方据此决定跳过还是提示版本不兼容。
   */
  readRaw(ref:SaveSlotRef):SaveRawReading {
    const key=this.key(ref);
    let raw:string|null;
    try { raw=this.storage.getItem(key); }
    catch { return {kind:'unreadable',reason:'无法读取本地存档'}; }
    if(raw===null)return {kind:'empty'};
    return this.rawOf(raw);
  }
  private rawOf(raw:string):SaveRawReading {
    let parsed:unknown;
    try { parsed=JSON.parse(raw); }
    catch { return {kind:'unreadable',reason:'存档内容不是有效 JSON'}; }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
      return {kind:'unreadable',reason:'存档内容不是对象'};
    const record=parsed as Partial<SaveGame<World>>;
    const status=saveFormatStatus(record.format);
    if(status==='future')return {kind:'future',reason:`存档版本 ${String(record.format)} 比当前游戏新`};
    if(status==='obsolete')return {kind:'obsolete',reason:`存档版本 ${String(record.format)} 过旧`};
    if(status==='unknown')return {kind:'unreadable',reason:'存档缺少有效版本'};
    if(!record.session||typeof record.session!=='object'||Array.isArray(record.session)||
      !record.world||typeof record.world!=='object'||Array.isArray(record.world))
      return {kind:'unreadable',reason:'存档缺少会话或世界状态'};
    const summary=record.summary;
    if(!summary||typeof summary.classId!=='string'||typeof summary.mapId!=='string'||!Number.isFinite(summary.level))
      return {kind:'unreadable',reason:'存档摘要无效'};
    return {kind:'ok',raw,summary,format:record.format as number};
  }
  /**
   * 写入云端下载的原始 JSON。只接受 `readRaw` 判为有效的档；未来/过旧/损坏不落地。
   * 不沿用 `write()` 的保留旧名逻辑，云端存档的 `summary.name` 是什么就写什么。
   */
  writeRaw(ref:SaveSlotRef, raw:string):void {
    const reading=this.rawOf(raw);
    if(reading.kind!=='ok'){
      const reason=reading.kind==='future'?'云端存档版本比当前游戏新，请先更新游戏'
        :reading.kind==='obsolete'?'云端存档版本过旧，无法恢复'
        :reading.kind==='unreadable'?reading.reason
        :'云端存档为空';
      throw new Error(reason);
    }
    const key=this.key(ref);this.storage.setItem(key,raw);this.summaryCache.delete(key);
  }
  /**
   * 写不进去（容量或隐私模式）就抛错，由界面报「保存失败」。
   *
   * 覆盖手动槽时沿用原来的自定义名字：只有玩家改名才会换名字。自动槽没有改名入口，
   * 直接写，不为拿名字解析旧档。手动槽优先用 `peek` 已缓存的摘要，没缓存才解析一次；
   * 写完用刚写出的 raw 和摘要回填，下一次读槽不用重新解析。
   */
  write(ref:SaveSlotRef, game:SaveGame<World>):void {
    let record=game;
    if(ref!==AUTO_SAVE_SLOT&&game.summary.name===undefined){
      const existing=this.peek(ref);
      if(existing.kind==='ok'&&existing.summary.name!==undefined)
        record={...game,summary:{...game.summary,name:existing.summary.name}};
    }
    const key=this.key(ref),raw=JSON.stringify(record);
    this.storage.setItem(key,raw);
    // 只有结构上确实能被读成有效档时才回填缓存；否则删掉缓存，让下次读取重新按内容分类。
    // 摘要复制一份再缓存：调用方之后改自己的 summary 不能让读槽结果和磁盘内容分叉。
    if(this.readableRecord(record))this.summaryCache.set(key,{raw,reading:{kind:'ok',summary:{...record.summary}}});
    else this.summaryCache.delete(key);
  }
  /** 写后回填缓存用的结构检查：与 `peek`/`inspect` 共用 `summaryReadingOf`，但不再解析一遍 JSON。 */
  private readableRecord(record:SaveGame<World>):boolean {
    return this.summaryReadingOf(record).kind==='ok';
  }
  erase(ref:SaveSlotRef):void { const key=this.manualKey(ref);this.storage.removeItem(key);this.summaryCache.delete(key); }
  /**
   * 改存档名字。名字按 `sanitizeSaveName` 过滤；过滤后为空表示清掉自定义名字。
   * 返回实际存下的名字（清空时为 undefined）；槽里没有有效存档时不改。
   */
  rename(ref:SaveSlotRef, name:string):string|undefined {
    this.manualKey(ref);
    const reading=this.inspect(ref);
    if(reading.kind!=='ok')throw new Error('这个存档槽里没有可以改名的存档');
    const applied=sanitizeSaveName(name)||undefined;
    const summary={ ...reading.game.summary };
    if(applied===undefined)delete summary.name;else summary.name=applied;
    const key=this.key(ref);this.storage.setItem(key,JSON.stringify({ ...reading.game, summary }));this.summaryCache.delete(key);
    return applied;
  }
}

/** 没有 localStorage 时（Node 里跑测试、或浏览器禁用了存储）读起来是空槽，写入直接失败。 */
const noStorage:SaveStorage = {
  getItem:()=>null,
  setItem:()=>{ throw new Error('当前环境不支持本地存档'); },
  removeItem:()=>{ throw new Error('当前环境不支持本地存档'); }
};
